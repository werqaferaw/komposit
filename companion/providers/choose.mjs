// Which provider, credentials and model run an API turn for the AI the person
// chose. Pure: the local server (engines/index.mjs) and the web page (where
// API keys can live in the browser) pick the same way.
//
//   anthropic  their Anthropic key (Claude Opus 5.5 unless they named a model)
//   invite     the owner's key through the gateway; the invite code is the key
//   account    the same gateway, with a signed-in session in place of a code
//   gemini     their Google Gemini key, through Gemini's OpenAI-compatible API
//   openai     any OpenAI-compatible service (OpenRouter, OpenAI, ...)
//
// `family` is whose history format the turn keeps (thinking blocks from one
// provider mean nothing to another); a chat's stored history restarts when it
// changes. Returns null for an AI that isn't an API (Claude Code, Codex).
import { anthropic, DEFAULT_MODEL } from "./anthropic.mjs";
import { openai, GEMINI } from "./openai.mjs";

export const DEFAULT_GATEWAY = "https://gateway.komposit.werq.dev";

export function apiTurnConfig(ai, { gateway = DEFAULT_GATEWAY } = {}) {
  switch (ai?.mode) {
    case "anthropic":
      return { provider: anthropic, family: "anthropic", creds: { apiKey: ai.anthropic?.apiKey, baseUrl: ai.anthropic?.baseUrl }, model: ai.anthropic?.model || DEFAULT_MODEL };
    case "invite":
      return { provider: anthropic, family: "anthropic", creds: { apiKey: ai.invite?.code, baseUrl: ai.invite?.gateway || gateway }, model: DEFAULT_MODEL };
    case "account":
      return { provider: anthropic, family: "anthropic", creds: { apiKey: ai.account?.session, baseUrl: gateway }, model: DEFAULT_MODEL };
    case "gemini":
      return { provider: openai, family: "openai", creds: { apiKey: ai.gemini?.apiKey, baseUrl: GEMINI.baseUrl, flavor: "gemini" }, model: ai.gemini?.model || GEMINI.models[0] };
    case "openai":
      return { provider: openai, family: "openai", creds: { apiKey: ai.openai?.apiKey, baseUrl: ai.openai?.baseUrl, flavor: ai.openai?.flavor }, model: ai.openai?.model };
    default:
      return null;
  }
}
