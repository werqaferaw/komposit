// OpenAI-compatible provider: OpenRouter, OpenAI, and anything else that speaks
// the Chat Completions wire format (DeepSeek, Groq, Together, vLLM, Ollama,
// LM Studio, ...). Same { name, stream } seam as anthropic.mjs. The harness keeps
// an Anthropic-shaped history; this adapter translates it to Chat Completions on
// the way out and folds the streamed reply back into Anthropic-shaped blocks
// (an optional reasoning_details block, one text block, then tool_use blocks)
// on the way in.
//
//   stream({ system, messages, tools, model, effort, creds: { apiKey, baseUrl, flavor },
//            maxTokens, onEvent, signal }) -> { stopReason, content, usage }
//
// `flavor` ("openrouter" | "openai" | "gemini" | "generic") selects the few wire
// differences: attribution headers, the token-limit field, how reasoning effort
// is sent, and which reasoning state goes back. When it's absent it's inferred
// from the base URL's host. Global fetch only.
//
// Reasoning round trip, so the model can continue its reasoning across tool calls:
//   OpenRouter  streamed reasoning_details come back as a { type: "reasoning_details",
//               details } block first in `content`; the loop keeps it in the
//               history, and the next request returns it on that assistant message.
//   Gemini      thought signatures ride on the tool calls (`extra_content`, e.g.
//               { google: { thought_signature } }); they're kept on each tool_use
//               block and sent back on the same call. Gemini 3 and later refuse a
//               function call in the current turn without its signature.

const DEFAULT_MAX_TOKENS = 16000;
const GEMINI_MAX_TOKENS = 32768; // Gemini counts thinking toward the output limit
const FLAVORS = ["openrouter", "openai", "gemini", "generic"];
const DEFAULT_BASE_URL = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
};
const KEY_NAME = { openrouter: "OpenRouter", openai: "OpenAI", gemini: "Gemini" };
const SHOTS_INTRO = "Screenshots returned by the tools above:";

// Google Gemini with a key from AI Studio, through its OpenAI-compatible endpoint.
// When a key is saved, the key check picks the first model in `models` the key
// can actually use (best first: a key without billing lists the Pro-class
// models but has no quota for them) and the first of `titleModels` (fast) to
// name chats.
export const GEMINI = {
  baseUrl: DEFAULT_BASE_URL.gemini,
  models: ["gemini-4-argon", "gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3-pro-preview", "gemini-3-flash-preview"],
  titleModels: ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3-flash-preview"],
};
// Google's documented placeholder for a function call that has no signature of
// its own (made by another model earlier in the chat): it skips the check for
// that call only, instead of failing the whole request.
export const GEMINI_SKIP_SIGNATURE = "skip_thought_signature_validator";

async function stream({
  system,
  messages = [],
  tools = [],
  model,
  effort,
  creds = {},
  maxTokens,
  onEvent = () => {},
  signal,
}) {
  const apiKey = creds.apiKey || "";
  const flavor = FLAVORS.includes(creds.flavor) ? creds.flavor : inferFlavor(creds.baseUrl);
  const baseUrl = String(creds.baseUrl || DEFAULT_BASE_URL[flavor] || "")
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/, ""); // tolerate a pasted full endpoint URL
  if (!baseUrl) throw new Error("No base URL set for the OpenAI-compatible provider.");
  if (!model) throw new Error("No model set for the OpenAI-compatible provider.");
  if (!apiKey && flavor !== "generic") {
    throw new Error(`No ${KEY_NAME[flavor]} API key set.`);
  }

  const body = {
    model,
    messages: toChatMessages(system, messages, flavor),
    stream: true,
    stream_options: { include_usage: true },
    // OpenAI's reasoning models reject max_tokens; most other servers only know max_tokens.
    [flavor === "openai" ? "max_completion_tokens" : "max_tokens"]: maxTokens || (flavor === "gemini" ? GEMINI_MAX_TOKENS : DEFAULT_MAX_TOKENS),
  };
  const fnTools = toChatTools(tools);
  if (fnTools.length) {
    body.tools = fnTools;
    body.tool_choice = "auto";
  }
  if (effort) {
    if (flavor === "openrouter") body.reasoning = { effort };
    else if (flavor === "gemini") body.reasoning_effort = effort; // low | medium | high = Gemini's thinking levels
    else if (flavor === "openai" && (model.startsWith("o") || model.startsWith("gpt-5"))) body.reasoning_effort = effort;
  }

  const headers = { "content-type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`; // keyless local servers (Ollama, LM Studio) get none
  if (flavor === "openrouter") {
    headers["HTTP-Referer"] = "https://komposit.werq.dev";
    headers["X-Title"] = "Komposit";
  }

  const post = async (payload) => {
    try {
      return await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(payload), signal });
    } catch (e) {
      if (signal?.aborted || e?.name === "AbortError") throw e; // let the loop see a real abort
      const why = e?.cause?.message || e?.cause?.code || e?.message || String(e); // "fetch failed" alone says nothing
      throw new Error(`Could not reach ${baseUrl}: ${why}`, { cause: e });
    }
  };

  let res = await postRetrying(post, body, { signal, onEvent });
  // Safety net for the reasoning round trip: if a request that carried
  // reasoning_details is rejected with a 400 (say our fragment merge isn't what
  // the model signed), send it once more without them rather than break a
  // multi-step turn. The model then just continues without its earlier reasoning.
  if (res.status === 400 && body.messages.some((m) => m.reasoning_details)) {
    const why = await res.text().catch(() => "");
    onEvent({ type: "warning", message: `reasoning_details rejected (400); retrying without them. ${why.slice(0, 300)}` });
    // Also drop the reasoning param: a Claude model with thinking on may insist
    // on a thinking block in the tool loop, which a stripped history lacks.
    const { reasoning: _r, ...rest } = body;
    res = await post({ ...rest, messages: body.messages.map(({ reasoning_details, ...m }) => m) });
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw Object.assign(new Error(`Model request failed (${res.status}): ${detail.slice(0, 500)}`), { status: res.status, detail });
  }

  let text = "";
  let finishReason = null;
  let rawUsage = null;
  let messageExtra = null; // Gemini: extra_content on the message itself (a signature on text)
  const calls = []; // { id, name, args, started, extra }, in order of first appearance
  const callAt = new Map(); // the server's tool_calls[].index -> position in `calls`
  const details = []; // OpenRouter reasoning_details, merged, in order of first appearance
  const detailAt = new Map(); // `${index}|${type}` -> position in `details`

  const addText = (s) => {
    text += s;
    onEvent({ type: "text", delta: s });
  };

  function handleChunk(chunk) {
    if (chunk.error) throw streamError(chunk.error); // OpenRouter reports mid-stream failures this way
    if (chunk.usage) rawUsage = chunk.usage; // the final chunk (stream_options.include_usage)
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    if (!choice) return;
    const d = choice.delta || choice.message || {}; // `message` = a server that ignored stream: true
    if (typeof d.content === "string" && d.content) addText(d.content);
    if (typeof d.refusal === "string" && d.refusal) addText(d.refusal);
    const thought = typeof d.reasoning === "string" && d.reasoning ? d.reasoning : d.reasoning_content;
    if (typeof thought === "string" && thought) onEvent({ type: "thinking", delta: thought });
    if (Array.isArray(d.reasoning_details)) for (const r of d.reasoning_details) addReasoningDetail(r);
    if (isObject(d.extra_content)) messageExtra = mergeExtra(messageExtra, d.extra_content);
    if (Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) if (tc) addToolDelta(tc);
    if (choice.finish_reason === "error") throw streamError('the provider ended the response with finish_reason "error"');
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  // Tool calls stream index-keyed: id + name first, then the arguments in
  // fragments. Some servers omit `index`, repeat the id on every fragment, or put
  // every parallel call at index 0, so a fragment also matches by id, and a new
  // id at an index that already holds a different call starts a new call.
  function addToolDelta(tc) {
    const key = Number.isInteger(tc.index) ? tc.index : "none";
    let pos = tc.id ? calls.findIndex((c) => c.id === tc.id) : -1;
    if (pos === -1 && callAt.has(key) && (!tc.id || !calls[callAt.get(key)].id)) pos = callAt.get(key);
    if (pos === -1) pos = calls.push({ id: "", name: "", args: "", started: false, extra: null }) - 1;
    callAt.set(key, pos);

    const call = calls[pos];
    if (tc.id && !call.id) call.id = tc.id;
    const fn = tc.function || {};
    if (fn.name && !call.name) call.name = fn.name;
    if (typeof fn.arguments === "string") call.args += fn.arguments;
    else if (fn.arguments && typeof fn.arguments === "object") call.args = JSON.stringify(fn.arguments);
    if (isObject(tc.extra_content)) call.extra = mergeExtra(call.extra, tc.extra_content); // Gemini's thought signature
    if (!call.started && call.id && call.name) {
      call.started = true;
      onEvent({ type: "tool_use_start", id: call.id, name: call.name });
    }
  }

  // OpenRouter streams reasoning as reasoning_details fragments (reasoning.text
  // {text, signature}, reasoning.summary {summary}, reasoning.encrypted {data},
  // each with id/format/index). Fragments with the same index and type are one
  // detail: text, summary and data concatenate; any other field keeps its last
  // non-empty value (signature, id, format). Fragments without an index stand alone.
  function addReasoningDetail(frag) {
    if (!frag || typeof frag !== "object") return;
    const key = Number.isInteger(frag.index) ? `${frag.index}|${frag.type}` : null;
    if (key === null || !detailAt.has(key)) {
      const pos = details.push({ ...frag }) - 1;
      if (key !== null) detailAt.set(key, pos);
      return;
    }
    const merged = details[detailAt.get(key)];
    for (const [k, v] of Object.entries(frag)) {
      if (k === "index" || k === "type") continue;
      if (k === "text" || k === "summary" || k === "data") {
        if (typeof v === "string") merged[k] = (typeof merged[k] === "string" ? merged[k] : "") + v;
      } else if (v !== null && v !== undefined && v !== "") {
        merged[k] = v;
      }
    }
  }

  // SSE: act on `data:` lines, stop at [DONE]. Comments (": OPENROUTER PROCESSING"),
  // blank lines and event:/id: fields are ignored.
  const decoder = new TextDecoder();
  let buf = "";
  let head = ""; // the body text until the first data: line, to diagnose a reply that isn't SSE
  let sawData = false;
  let done = false;

  const onLine = (line) => {
    if (!line.startsWith("data:")) return;
    sawData = true;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      done = true;
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk && typeof chunk === "object") handleChunk(chunk);
  };

  // A reader rather than `for await` over the body, so the same code runs in
  // every browser the page supports. Leaving early (done, or a throw) cancels
  // the body, closing the connection.
  const reader = res.body.getReader();
  try {
    read: for (;;) {
      const { value: bytes, done: ended } = await reader.read();
      if (ended) break;
      const s = decoder.decode(bytes, { stream: true });
      if (!sawData && head.length < 1_000_000) head += s;
      buf += s;
      for (let nl; (nl = buf.indexOf("\n")) !== -1; ) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (done) break read;
      }
    }
  } finally {
    if (done) reader.cancel().catch(() => {});
    else reader.releaseLock?.();
  }
  if (!done) onLine(buf + decoder.decode()); // a final line without a trailing newline

  if (!sawData) {
    // Not an event stream: a whole JSON completion, or an error sent with a 2xx status.
    let whole = null;
    try {
      whole = JSON.parse(head);
    } catch {}
    if (!whole || (!whole.error && !Array.isArray(whole.choices))) {
      throw new Error(`Model reply was not an event stream: ${head.trim().slice(0, 500) || "(empty body)"}`);
    }
    handleChunk(whole);
  }

  const content = [];
  // First, like a thinking block. The loop stores content as returned (keepsThinking),
  // and assistantMessages() hands it back to OpenRouter on the next request.
  if (details.length) content.push({ type: "reasoning_details", details });
  if (messageExtra) content.push({ type: "extra_content", extra_content: messageExtra });
  if (text.trim()) content.push({ type: "text", text });
  // Every tool call needs an id no earlier call in this chat used: the steps in
  // the UI and the tool results are matched by it, and some servers number
  // their calls afresh each time ("function-call-1").
  const usedIds = new Set();
  for (const m of messages || []) {
    if (m?.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) if (b?.type === "tool_use" && b.id) usedIds.add(b.id);
  }
  for (const c of calls) {
    const id = c.id && !usedIds.has(c.id) ? c.id : newCallId();
    usedIds.add(id);
    content.push({ type: "tool_use", id, name: c.name, input: parseArgs(c.args), ...(c.extra ? { extra_content: c.extra } : {}) });
  }
  const stopReason = calls.length ? "tool_use" : finishReason === "length" ? "max_tokens" : "end_turn";

  // Chat Completions' prompt_tokens INCLUDES cached tokens; Anthropic's
  // input_tokens EXCLUDES them. Split them the Anthropic way, so usage reads
  // the same from either provider.
  const u = rawUsage || {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0; // the latter: DeepSeek
  const usage = {
    input_tokens: Math.max(0, (u.prompt_tokens || 0) - (cached || 0)),
    output_tokens: u.completion_tokens || 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached || 0,
  };

  onEvent({ type: "done", stopReason });
  return { stopReason, content, usage };
}

// One plain sentence for the person using the app; the full detail stays in the
// error's message for the logs.
export function explainError(e) {
  const status = e?.status;
  const detail = String(e?.detail || "");
  if (status === 401 || status === 403 || /api key not valid|invalid api key|incorrect api key|API_KEY_INVALID/i.test(detail)) {
    return { message: "The API key was not accepted by the AI service. Check it in Settings.", code: "auth" };
  }
  const limit = status === 429 ? quotaKind(detail) : null;
  if (limit === "none") {
    return { message: "This key has no quota for this model. Check its plan or billing with the AI service, or save the key again in Settings to switch to a model it can use.", code: "quota" };
  }
  if (limit === "day") return { message: "This key has used up today's quota for this model. Save the key again in Settings to switch to a model that still has some, try again tomorrow, or check its plan or billing with the AI service.", code: "quota" };
  if (status === 429) return { message: "The AI service is rate limiting this key. Wait a moment and try again.", code: "rate_limit" };
  if ((status === 503 || status === 529) && /demand|overload|unavailable/i.test(detail)) {
    return { message: "The model is overloaded right now (high demand). Try again in a minute.", code: "overloaded" };
  }
  if (status >= 500) return { message: `The AI service had a server problem (${status}). Try again.`, code: "server" };
  return { message: e?.message || String(e), code: status === 400 ? "bad_request" : null };
}

// keepsThinking: the loop stores the assistant content as returned, so the
// reasoning_details block and Gemini's signatures survive into the history. No
// thinkingIsProgress: raw reasoning is not a progress note meant for the person.
export const openai = { name: "openai", stream, explainError, keepsThinking: true };

export function inferFlavor(baseUrl) {
  let host = "";
  try {
    host = new URL(baseUrl).hostname;
  } catch {}
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) return "openrouter";
  if (host === "api.openai.com") return "openai";
  if (host === "generativelanguage.googleapis.com") return "gemini";
  return "generic";
}

// Busy servers: a model under high demand answers 503 (Gemini says so often),
// and gateways 502/504. Those, and a 429 that isn't about quota, are tried
// again after a pause (the server's Retry-After when it gives one), a few
// times, before the error reaches the person. Anything else is final.
const RETRY_STATUS = new Set([502, 503, 504, 529]);
const RETRY_WAITS = [2000, 4000, 8000, 16000];

async function postRetrying(post, payload, { signal, onEvent }) {
  let res = await post(payload);
  for (const base of RETRY_WAITS) {
    if (!RETRY_STATUS.has(res.status) && res.status !== 429) return res;
    const detail = await res.text().catch(() => "");
    const kind = res.status === 429 ? quotaKind(detail) : null;
    if (kind === "none" || kind === "day") {
      // Waiting won't help: no quota at all for this model, or today's is used up.
      throw Object.assign(new Error(`Model request failed (429): ${detail.slice(0, 500)}`), { status: 429, detail });
    }
    const after = Number(res.headers.get("retry-after"));
    const hinted = retryDelayMs(detail); // Google says how long in the body
    const wait = hinted !== null ? Math.min(hinted + 500, 65000) : Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 30000) : base + Math.floor(Math.random() * 500);
    onEvent({ type: "warning", message: `the service answered ${res.status}; trying again in ${Math.round(wait / 1000)} s` });
    await pause(wait, signal);
    res = await post(payload);
  }
  return res;
}

// What a 429 is about: "none" (this key has no quota for the model at all,
// e.g. a Pro model without billing: "limit: 0"), "day" (today's is used up),
// "minute" (a rate limit: try again shortly), or null (no quota words).
export function quotaKind(detail = "") {
  const d = String(detail);
  if (!/quota|RESOURCE_EXHAUSTED|billing|rate.?limit/i.test(d)) return null;
  if (/limit:\s*0\b|"quotaValue":\s*"0"/i.test(d)) return "none";
  if (/PerDay|per day|daily/i.test(d)) return "day";
  return "minute";
}

// Google's RetryInfo ("retryDelay": "34s") in milliseconds, or null.
function retryDelayMs(detail = "") {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(String(detail));
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// Fold one streamed extra_content fragment into what's collected so far: nested
// objects merge; any other value keeps the latest non-empty one.
function mergeExtra(into, frag) {
  const out = isObject(into) ? { ...into } : {};
  for (const [k, v] of Object.entries(frag)) {
    if (isObject(v)) out[k] = mergeExtra(out[k], v);
    else if (v !== null && v !== undefined && v !== "") out[k] = v;
  }
  return out;
}

function hasSignature(extra) {
  return typeof extra?.google?.thought_signature === "string" && extra.google.thought_signature !== "";
}

// ---- Anthropic-shaped history -> Chat Completions messages ----

function toChatMessages(system, messages, flavor) {
  const out = [];
  // system is a string today; accept Anthropic text blocks too (cache_control and all).
  const sys = Array.isArray(system) ? system.map((b) => b?.text || "").filter(Boolean).join("\n\n") : system;
  if (sys) out.push({ role: "system", content: sys });
  for (const m of messages || []) {
    if (m?.role === "assistant") out.push(...assistantMessages(m.content, flavor));
    else if (m?.role === "user") out.push(...userMessages(m.content));
  }
  return out;
}

function assistantMessages(content, flavor) {
  if (typeof content === "string") return content.trim() ? [{ role: "assistant", content }] : [];
  const texts = [];
  const toolCalls = [];
  const details = [];
  let messageExtra = null;
  const gemini = flavor === "gemini";
  for (const b of Array.isArray(content) ? content : []) {
    if (b?.type === "text" && b.text) texts.push(b.text);
    else if (b?.type === "tool_use") {
      const call = { id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } };
      if (gemini && isObject(b.extra_content)) call.extra_content = b.extra_content;
      toolCalls.push(call);
    } else if (b?.type === "reasoning_details" && Array.isArray(b.details)) details.push(...b.details);
    else if (b?.type === "extra_content" && isObject(b.extra_content)) messageExtra = b.extra_content;
    // thinking / redacted_thinking / anything else has no Chat Completions form: dropped.
  }
  const text = texts.join("\n\n");
  if (!text.trim() && !toolCalls.length) return []; // nothing to say; an empty assistant turn trips strict servers
  const msg = { role: "assistant", content: text.trim() ? text : null };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  // OpenRouter continues the model's reasoning across tool calls when it gets the
  // details back unmodified. Other servers don't know the field: never sent there.
  if (flavor === "openrouter" && details.length) msg.reasoning_details = details;
  if (gemini) {
    // Gemini wants the signature back on the call it came with. Only the first
    // call of a step carries one; a step without (made by another model, or
    // older history) gets Google's skip placeholder so the request still goes.
    if (toolCalls.length && !hasSignature(toolCalls[0].extra_content)) {
      toolCalls[0].extra_content = mergeExtra(toolCalls[0].extra_content, { google: { thought_signature: GEMINI_SKIP_SIGNATURE } });
    }
    if (messageExtra) msg.extra_content = messageExtra;
  }
  return [msg];
}

// One Anthropic user turn can become several Chat messages, in this order:
// one `tool` message per tool_result (they must directly follow the assistant's
// tool_calls), then one user message carrying every image those tools returned
// (tool messages can't hold images), then the user's own text/images.
function userMessages(content) {
  if (typeof content === "string") return [{ role: "user", content }];
  const toolMsgs = [];
  const shots = [];
  const parts = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (b?.type === "text" && b.text) parts.push({ type: "text", text: b.text });
    else if (b?.type === "image") {
      const p = imagePart(b);
      if (p) parts.push(p);
    } else if (b?.type === "tool_result") {
      const { text, images } = flattenToolResult(b.content);
      shots.push(...images);
      const out = text || (images.length ? "(see the screenshot below)" : "(no output)");
      toolMsgs.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${out}` : out });
    }
  }
  const out = [...toolMsgs];
  if (shots.length) out.push({ role: "user", content: [{ type: "text", text: SHOTS_INTRO }, ...shots] });
  if (parts.length) {
    // Text-only turns go as a plain string: some servers (DeepSeek, older vLLM) reject content arrays.
    const textOnly = parts.every((p) => p.type === "text");
    out.push({ role: "user", content: textOnly ? parts.map((p) => p.text).join("\n\n") : parts });
  }
  return out;
}

function flattenToolResult(content) {
  if (typeof content === "string") return { text: content, images: [] };
  const texts = [];
  const images = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (b?.type === "text" && b.text) texts.push(b.text);
    else if (b?.type === "image") {
      const p = imagePart(b);
      if (p) images.push(p);
    }
  }
  return { text: texts.join("\n"), images };
}

function imagePart(block) {
  const s = block.source || {};
  if (s.type === "base64" && s.data) {
    return { type: "image_url", image_url: { url: `data:${s.media_type || "image/png"};base64,${s.data}` } };
  }
  if (s.type === "url" && s.url) return { type: "image_url", image_url: { url: s.url } };
  return null;
}

function toChatTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .filter((t) => t?.name)
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }));
}

// ---- reply helpers ----

// Arguments are a JSON string. Empty means a no-argument call (inspect, render).
// Anything that isn't a JSON object comes back as { __invalid_json } so the loop
// can tell the model its call was malformed instead of running it.
function parseArgs(raw) {
  if (!raw.trim()) return {};
  try {
    let v = JSON.parse(raw);
    if (typeof v === "string") v = JSON.parse(v); // a few servers double-encode
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  return { __invalid_json: raw };
}

// Fallback for servers that stream a tool call without an id. The shape is also a
// valid Anthropic tool_use id, so the history survives a switch back to anthropic.
function newCallId() {
  return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function streamError(err) {
  const detail = typeof err === "string" ? err : JSON.stringify(err);
  return new Error(`Model stream error: ${detail.slice(0, 500)}`);
}
