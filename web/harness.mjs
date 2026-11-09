// The agent loop for the hosted page, bundled for the browser by build.mjs into
// public/harness.js. It is the same code the local server runs: the loop and
// prompts in companion/harness/core, the providers in companion/providers. The
// page (ui/app.js) reaches it as window.KompositHarness; the model is called
// straight from the browser, and every tool call goes to the Komposit app on
// this computer (POST /api/tool).
import { runTurn } from "../companion/harness/core/loop.mjs";
import { apiTurnConfig, DEFAULT_GATEWAY } from "../companion/providers/choose.mjs";
import { checkAnthropicKey, checkGeminiKey, checkOpenAIKey, checkInvite, flavorOf, OPENAI_PRESETS } from "../companion/providers/keys.mjs";
import { GEMINI } from "../companion/providers/openai.mjs";
import { nameWithApi } from "../companion/harness/core/naming.mjs";
import { stepLabel, doneLabel, cleanToolName } from "../companion/labels.mjs";

globalThis.KompositHarness = Object.freeze({
  version: 1,
  runTurn,
  apiTurnConfig,
  nameChat: nameWithApi,
  keys: { checkAnthropicKey, checkGeminiKey, checkOpenAIKey, checkInvite, flavorOf },
  labels: { stepLabel, doneLabel, cleanToolName },
  OPENAI_PRESETS,
  GEMINI,
  DEFAULT_GATEWAY,
});
