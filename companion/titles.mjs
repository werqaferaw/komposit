// Chat titles named by the AI, the way other chat apps do it: when a chat
// starts, a small fast model reads the first message and names the chat in a
// few words. It runs beside the turn, never blocks it, and on any failure the
// chat keeps its provisional title (the start of the first message).
//
// Each AI choice names chats on its own account:
//   claude-code  Haiku through the person's Claude Code, no tools, no session
//   anthropic    Haiku on their API key
//   invite       Haiku through the gateway (one request off the daily quota)
//   gemini       a fast Gemini model on their key (picked when the key was saved)
//   openai       the model they configured
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { findClaude, userEnv } from "./shellenv.mjs";
import { DEFAULT_GATEWAY } from "./config.mjs";
import { GEMINI, inferFlavor } from "./providers/openai.mjs";

import { SYSTEM, titlePrompt, cleanTitle, TITLE_MODEL, TIMEOUT_MS } from "./harness/core/naming.mjs";

export { SYSTEM, titlePrompt, cleanTitle };

async function viaClaudeCode(prompt, signal) {
  const claude = await findClaude();
  if (!claude) return "";
  const env = await userEnv();
  delete env.ANTHROPIC_API_KEY; // subscription billing only, as for turns
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  const args = [
    "-p",
    "--model", "haiku",
    "--tools", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--setting-sources", "",
    "--output-format", "text",
    "--system-prompt", SYSTEM,
  ];
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(claude, args, { stdio: ["pipe", "pipe", "ignore"], env, windowsHide: true });
    } catch {
      return resolve("");
    }
    const kill = () => { try { child.kill(); } catch {} };
    signal?.addEventListener("abort", kill, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => resolve(""));
    child.on("close", (code) => resolve(code === 0 ? out : ""));
    child.stdin.on("error", () => {});
    child.stdin.end(prompt); // the prompt on stdin: no quoting or length limits
  });
}

async function viaAnthropic(prompt, creds, signal) {
  if (!creds.apiKey) return "";
  const client = new Anthropic({ apiKey: creds.apiKey, ...(creds.baseUrl ? { baseURL: creds.baseUrl } : {}), maxRetries: 1, timeout: TIMEOUT_MS });
  const msg = await client.messages.create(
    { model: TITLE_MODEL, max_tokens: 40, system: SYSTEM, messages: [{ role: "user", content: prompt }] },
    { signal },
  );
  return (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

async function viaOpenAI(prompt, o, signal) {
  const flavor = o.flavor || inferFlavor(o.baseUrl);
  const base = String(o.baseUrl || { openrouter: "https://openrouter.ai/api/v1", openai: "https://api.openai.com/v1", gemini: GEMINI.baseUrl }[flavor] || "")
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/, "");
  if (!base || !o.model) return "";
  const headers = { "content-type": "application/json" };
  if (o.apiKey) headers.Authorization = `Bearer ${o.apiKey}`;
  const body = {
    model: o.model,
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
    // Reasoning models spend tokens thinking before the title: leave room.
    [flavor === "openai" ? "max_completion_tokens" : "max_tokens"]: 1000,
  };
  if (flavor === "gemini") body.reasoning_effort = "low"; // a title needs little thought
  const r = await fetch(`${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!r.ok) return "";
  const j = await r.json();
  return j?.choices?.[0]?.message?.content || "";
}

// Name a chat from its first message. Resolves to a title or "" (never throws).
export async function nameChat(ai, { text, app, files = [] } = {}) {
  if (!String(text || "").trim() && !files.length) return "";
  const prompt = titlePrompt({ text, app, files });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let raw = "";
    if (ai?.mode === "claude-code") raw = await viaClaudeCode(prompt, ctl.signal);
    else if (ai?.mode === "anthropic") raw = await viaAnthropic(prompt, { apiKey: ai.anthropic?.apiKey, baseUrl: ai.anthropic?.baseUrl }, ctl.signal);
    else if (ai?.mode === "invite") raw = await viaAnthropic(prompt, { apiKey: ai.invite?.code, baseUrl: ai.invite?.gateway || DEFAULT_GATEWAY }, ctl.signal);
    else if (ai?.mode === "gemini") {
      const g = ai.gemini || {};
      raw = await viaOpenAI(prompt, { apiKey: g.apiKey, baseUrl: GEMINI.baseUrl, flavor: "gemini", model: g.titleModel || g.model || GEMINI.titleModels[0] }, ctl.signal);
    } else if (ai?.mode === "openai") raw = await viaOpenAI(prompt, ai.openai || {}, ctl.signal);
    return cleanTitle(raw);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
