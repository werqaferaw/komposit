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
import { findClaude, userEnv } from "./shellenv.mjs";
import { DEFAULT_GATEWAY } from "./config.mjs";
import { SYSTEM, titlePrompt, cleanTitle, nameWithApi, TIMEOUT_MS } from "./harness/core/naming.mjs";

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

// Name a chat from its first message. Resolves to a title or "" (never throws).
export async function nameChat(ai, { text, app, files = [] } = {}) {
  if (!String(text || "").trim() && !files.length) return "";
  if (ai?.mode !== "claude-code") return nameWithApi(ai, { text, app, files }, { gateway: DEFAULT_GATEWAY });
  const prompt = titlePrompt({ text, app, files });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return cleanTitle(await viaClaudeCode(prompt, ctl.signal));
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
