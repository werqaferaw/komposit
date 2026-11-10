// Checking an API key or invite code before it's saved, by asking the service
// itself. Pure (fetch and the SDK only): the local server checks keys the
// person saves in the app, and the web page checks keys it keeps in the
// browser, the same way.
import Anthropic from "@anthropic-ai/sdk";
import { GEMINI, quotaKind, inferFlavor } from "./openai.mjs";
import { DEFAULT_GATEWAY } from "./choose.mjs";

const IN_BROWSER = typeof window !== "undefined" && typeof document !== "undefined";

export const OPENAI_PRESETS = {
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-5.5" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-5" },
};

// Which wire flavor a service address speaks (Gemini at its own address
// included, so its thought signatures go back).
export const flavorOf = inferFlavor;

export async function checkAnthropicKey(apiKey) {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 15000, ...(IN_BROWSER ? { dangerouslyAllowBrowser: true } : {}) });
  try {
    await client.models.list({ limit: 1 });
    return { ok: true };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, error: "That key was not accepted by Anthropic." };
    if (e instanceof Anthropic.PermissionDeniedError) return { ok: false, error: "That key has no access to the API." };
    return { ok: false, error: `Could not reach Anthropic: ${e.message}` };
  }
}

export async function checkOpenAIKey({ apiKey, baseUrl }) {
  const flavor = flavorOf(baseUrl);
  // OpenRouter lists models without auth, so check the key endpoint instead.
  const url = flavor === "openrouter" ? "https://openrouter.ai/api/v1/key" : `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "That key was not accepted." };
    if (!res.ok && res.status !== 404) return { ok: false, error: `The service answered ${res.status}.` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not reach ${baseUrl}: ${e.message}` };
  }
}

// A Gemini key: list the models it may use (the OpenAI-compatible endpoint),
// then pick the best one that really answers for turns and a fast one for chat
// titles. A model the person named is kept as long as the key can use it.
export async function checkGeminiKey(apiKey, { model = "", baseUrl = GEMINI.baseUrl, probe = modelAnswers } = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return { ok: false, error: `Could not reach Google: ${e.message}` };
  }
  const body = await res.text().catch(() => "");
  // Google answers a bad key with 400 ("API key not valid") as often as 401/403.
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    return { ok: false, error: /api key|API_KEY/i.test(body) || res.status !== 400 ? "That key was not accepted by Google." : `Google refused the check: ${body.slice(0, 200)}` };
  }
  if (!res.ok) return { ok: false, error: `Google answered ${res.status}.` };
  let ids = [];
  try {
    ids = (JSON.parse(body).data || []).map((m) => String(m.id || "").replace(/^models\//, "")).filter(Boolean);
  } catch {}
  const has = (id) => ids.includes(id);
  const want = String(model || "").trim().replace(/^models\//, "");
  if (want && ids.length && !has(want)) return { ok: false, error: `This key can't use ${want}. Leave the model empty to use the best one available.` };

  // The first candidate the key really may call (listed is not enough: a key
  // without billing lists models it has no quota for). Each model is asked once.
  const asked = new Map();
  const answers = async (id) => {
    if (!asked.has(id)) asked.set(id, await probe(apiKey, id, baseUrl));
    return asked.get(id);
  };
  const first = async (list) => {
    for (const id of list) if ((await answers(id)).usable) return id;
    return null;
  };
  let chosen = want;
  if (want) {
    const p = await answers(want);
    if (!p.usable) return { ok: false, error: `This key can't use ${want} right now${p.quota ? " (no quota: Pro-class models need billing turned on in Google AI Studio)" : ""}. Leave the model empty to use the best one it can.` };
  } else {
    const listed = [...GEMINI.models.filter(has), ...[newestListed(ids)].filter((id) => id && !GEMINI.models.includes(id))];
    chosen = (await first(listed.length ? listed : GEMINI.models)) || null;
    if (!chosen) return { ok: false, error: "This key can't use any Gemini model right now (no quota). Check the key's plan or billing in Google AI Studio." };
  }
  const titleModel = (await first(GEMINI.titleModels.filter(has))) || chosen;
  return { ok: true, model: chosen, titleModel, pinned: !!want };
}

// Does this model answer this key right now? Asks for a streamed reply and
// stops as soon as the answer starts, so nothing much is generated. A quota
// or not-found answer comes back at once; a model that's still quiet after a
// few seconds is thinking about its reply, so it's usable.
export async function modelAnswers(apiKey, model, baseUrl = GEMINI.baseUrl, { waitMs = 8000 } = {}) {
  const ctl = new AbortController();
  let timer;
  try {
    const res = await Promise.race([
      fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with OK." }], stream: true, max_tokens: 64, reasoning_effort: "low" }),
        signal: ctl.signal,
      }),
      new Promise((resolve) => (timer = setTimeout(() => resolve(null), waitMs))),
    ]);
    if (!res) return { usable: true, status: null };
    const detail = res.ok ? "" : await res.text().catch(() => "");
    const kind = res.status === 429 ? quotaKind(detail) : null;
    // A per-minute limit means the key may use the model, just not this second.
    return { usable: res.ok || kind === "minute", status: res.status, quota: kind === "none" || kind === "day" };
  } catch (e) {
    return { usable: false, status: 0 };
  } finally {
    clearTimeout(timer);
    ctl.abort(); // stop the reply: this was only a check
  }
}

// When Google has renamed its models since this build: the newest general
// model the key lists (Pro-class before Flash), not a speech, image or live one.
function newestListed(ids) {
  const version = (id) => parseFloat((/^gemini-(\d+(?:\.\d+)?)/.exec(id) || [])[1] || "0");
  const tier = (id) => (/pro|ultra|argon/.test(id) ? 2 : /flash/.test(id) ? 1 : 0);
  const general = ids.filter((id) => /^gemini-\d/.test(id) && !/tts|live|embed|image|audio|transcribe|robotics|computer-use|lite/.test(id));
  return general.sort((a, b) => version(b) - version(a) || tier(b) - tier(a))[0] || null;
}

// Ask the invite gateway who this code belongs to (and its limits).
export async function checkInvite(code, gateway = DEFAULT_GATEWAY) {
  try {
    const res = await fetch(`${gateway.replace(/\/+$/, "")}/v1/me`, {
      headers: { "x-api-key": code },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) return { ok: false, error: "That invite code isn't valid." };
    if (!res.ok) return { ok: false, error: `The invite service answered ${res.status}.` };
    const me = await res.json();
    return { ok: true, name: me.name || null, limits: me.limits || null, usage: me.usage || null };
  } catch (e) {
    return { ok: false, error: `Could not reach the invite service: ${e.message}` };
  }
}

