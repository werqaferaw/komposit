// The design-operator prompt: who Komposit is, how it behaves (behavior.mjs,
// shared with the subscription engines), and the per-app ExtendScript guidance.
// Pure: the local server and the web page build the very same prompt.
import { esGuidance, esGuidanceAll } from "../guidance.mjs";
import { behavior } from "./behavior.mjs";

// One system prompt for every app (the API engine): it never changes during a
// chat, which keeps the prompt cache and the model's earlier thinking valid.
// Each user message says which app is active. `mod`: see behavior.mjs.
export function buildSystem(app, { mod = "Cmd" } = {}) {
  return core(
    `You are Komposit, a design agent working directly in the user's open Adobe documents (Illustrator, Photoshop, After Effects). Each message starts with a line naming the app it is about; your tools act on the active document of that app.`,
    app ? esGuidance(app) : esGuidanceAll(),
    mod,
  );
}

function core(intro, guidance, mod) {
  return `${intro}

${behavior(mod)}

Tools: inspect (state map + screenshot), edit, undo, render, export, save, preflight. Reach for only what the task needs.

Notes on the tools:
- Edits are ExtendScript (ES3): var, string concatenation; no let/const, arrow functions, template strings or JSON.
- When you inspect, use the exact \`ref\`s it returns rather than guessing object paths.
- Render to verify, mainly right before you finish, not after every small edit.

While you work, the user sees your short notes between steps; write them in plain language (what you found, what you'll do next).

${guidance}`;
}
