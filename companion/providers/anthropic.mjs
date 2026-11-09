// Anthropic provider, on the official SDK. One call = one streamed model
// response; the harness loop (harness/loop.mjs) runs the tools in between.
//
// Request shape (Claude Opus 5.5 by default):
//   - adaptive thinking (always on for Opus 5.5) with display "updates", so the
//     short notes the model writes between tool calls arrive as readable text
//   - output_config.effort from the Fast / Balanced / Thorough picker
//   - fallbacks "default": if a safety classifier declines a request, the API
//     re-runs it on Anthropic's recommended fallback model instead of failing
//   - prompt caching: a breakpoint on the system prompt plus automatic caching
//     for the growing conversation (the history is append-only, so it hits)
//   - eager_input_streaming on our tools; inputs are validated before running
//
// Works against api.anthropic.com with the tester's key, or against the invite
// gateway (same API) with an invite code in place of the key. Runs in Node (the
// local server) and in the web page, where the SDK calls the API straight from
// the browser: the key never leaves the page except to go to the API.
import Anthropic from "@anthropic-ai/sdk";

// In a page the SDK refuses to run unless told the key is the person's own,
// typed into this page (it also adds the header Anthropic's CORS needs).
const IN_BROWSER = typeof window !== "undefined" && typeof document !== "undefined";

export const DEFAULT_MODEL = "claude-opus-5-5";

const BETAS = ["thinking-display-updates-2026-08-18", "server-side-fallback-2026-07-01"];

const clients = new Map();
function clientFor({ apiKey, baseUrl } = {}) {
  const key = `${apiKey}|${baseUrl || ""}`;
  let c = clients.get(key);
  if (!c) {
    c = new Anthropic({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
      ...(IN_BROWSER ? { dangerouslyAllowBrowser: true } : {}),
      maxRetries: 2,
      timeout: 15 * 60 * 1000, // long thinking turns stream for minutes
    });
    clients.set(key, c);
  }
  return c;
}

// Turn SDK errors into one plain sentence for the person using the app.
export function explainError(e) {
  if (e instanceof Anthropic.AuthenticationError) return { message: "The API key or invite code was not accepted.", code: "auth" };
  if (e instanceof Anthropic.PermissionDeniedError) return { message: "This key has no access to that model.", code: "permission" };
  if (e instanceof Anthropic.RateLimitError) {
    const msg = e.error?.error?.message || "";
    return { message: msg && /invite|limit/i.test(msg) ? msg : "Rate limited. Wait a moment and try again.", code: "rate_limit" };
  }
  if (e instanceof Anthropic.BadRequestError) return { message: `The request was rejected: ${e.error?.error?.message || e.message}`, code: "bad_request" };
  if (e instanceof Anthropic.InternalServerError) return { message: "Anthropic had a server problem. Try again.", code: "server" };
  if (e instanceof Anthropic.APIConnectionError) return { message: "Could not reach the AI service. Check your connection.", code: "network" };
  return { message: e.message || String(e), code: null };
}

async function stream({
  system,
  messages,
  tools,
  model = DEFAULT_MODEL,
  effort = "medium",
  creds = {},
  maxTokens = 64000,
  onEvent = () => {},
  signal,
}) {
  const client = clientFor(creds);
  const params = {
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: tools.map((t) => ({ ...t, eager_input_streaming: true })),
    messages,
    thinking: { type: "adaptive", display: "updates" },
    output_config: { effort },
    fallbacks: "default",
    cache_control: { type: "ephemeral" },
    betas: BETAS,
  };

  const s = client.beta.messages.stream(params, { signal });
  for await (const ev of s) {
    if (ev.type === "content_block_start") {
      onEvent({ type: "block_start", index: ev.index, block: ev.content_block.type, name: ev.content_block.name });
    } else if (ev.type === "content_block_delta") {
      if (ev.delta.type === "text_delta") onEvent({ type: "text", index: ev.index, delta: ev.delta.text });
      else if (ev.delta.type === "thinking_delta") onEvent({ type: "thinking", index: ev.index, delta: ev.delta.thinking });
    } else if (ev.type === "content_block_stop") {
      onEvent({ type: "block_stop", index: ev.index });
    }
  }
  const msg = await s.finalMessage();
  return { stopReason: msg.stop_reason, content: msg.content, usage: msg.usage || {}, model: msg.model };
}

// thinkingIsProgress: under display "updates" each non-empty thinking block is
// a short progress note meant for the person, so the loop shows it.
export const anthropic = { name: "anthropic", stream, explainError, thinkingIsProgress: true, keepsThinking: true };
