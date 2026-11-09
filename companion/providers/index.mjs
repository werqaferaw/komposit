// Provider registry: the model-backend seam for the API engine. The harness
// loop talks only to a provider's
//   { name, stream({system, messages, tools, model, effort, creds, maxTokens, onEvent, signal})
//       -> {stopReason, content, usage}, explainError?, thinkingIsProgress?, keepsThinking? }
// contract, so adding a backend is additive.
//
//   anthropic  the Claude API with the tester's key, or the invite gateway
//   openai     any OpenAI-compatible Chat Completions service (OpenRouter,
//              OpenAI, a local server)
import { anthropic } from "./anthropic.mjs";
import { openai } from "./openai.mjs";

const PROVIDERS = { anthropic, openai };

export function getProvider(name) {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown model provider "${name}". Have: ${Object.keys(PROVIDERS).join(", ")}`);
  return p;
}

export { PROVIDERS };
