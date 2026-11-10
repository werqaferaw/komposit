// Which engine runs a turn, from the AI the tester chose in settings:
//
//   claude-code  their Claude subscription, through Claude Code on this Mac
//   codex        their ChatGPT plan, through Codex on this Mac
//   anthropic    their Anthropic API key
//   gemini       their Google Gemini API key (the OpenAI-compatible provider)
//   invite       the owner's key, through the invite gateway (the key never
//                reaches this Mac; the invite code stands in for it)
//   openai       an OpenAI-compatible key (OpenRouter, OpenAI, ...)
//
// The Fast / Balanced / Thorough picker maps to effort (and, for Claude Code,
// the model: Sonnet is much faster per step; Opus for hard design reasoning).
import { runCliTurn } from "./cli.mjs";
import { runCodexTurn } from "./codex.mjs";
import { runTurn } from "../harness/loop.mjs";
import { apiTurnConfig } from "../providers/choose.mjs";
import { DEFAULT_GATEWAY } from "../config.mjs";
import * as chats from "../chats.mjs";
import { readSelection, selectionBlock, selectionNote } from "../harness/context.mjs";
import { filesBlock } from "../harness/attachments.mjs";
import { dirname } from "node:path";

export const EFFORTS = {
  low: { label: "Fast", cli: { model: "sonnet", effort: "low" }, api: "low" },
  medium: { label: "Balanced", cli: { model: "sonnet", effort: "medium" }, api: "medium" },
  high: { label: "Thorough", cli: { model: "opus", effort: "high" }, api: "high" },
};

// The live selection goes in front of the message (the model reads it; the
// chat shows the person's own words), plus one quiet step line, then the list
// of attached files. Also used for turns the web page runs (server.mjs).
export async function withContext({ app, text, files = [], emit }) {
  const sel = await readSelection(app);
  const note = selectionNote(app, sel);
  if (note) emit({ type: "note", text: note });
  return selectionBlock(app, sel) + filesBlock(files) + (text || "");
}

export async function runTurnFor(ai, { chat, app, text, images, files = [], effort, emit, signal }) {
  const lvl = EFFORTS[effort] || EFFORTS.medium;
  text = await withContext({ app, text, files, emit });

  if (ai.mode === "claude-code") {
    chat.cli = chat.cli || {};
    const r = await runCliTurn({
      app,
      userText: text,
      images,
      fileDirs: files.length ? [...new Set(files.map((f) => dirname(f.path)))] : [],
      emit,
      signal,
      model: lvl.cli.model,
      effort: lvl.cli.effort,
      resume: chat.cli[app] || null,
    });
    if (r?.sessionId) chat.cli[app] = r.sessionId;
    else if (r?.resumeFailed) delete chat.cli[app];
    return;
  }

  // Codex: one thread per chat and app, like Claude Code's sessions. Its
  // reasoning effort is the picker's low / medium / high.
  if (ai.mode === "codex") {
    chat.codex = chat.codex || {};
    const r = await runCodexTurn({
      app,
      userText: text,
      images,
      fileDirs: files.length ? [...new Set(files.map((f) => dirname(f.path)))] : [],
      emit,
      signal,
      effort: lvl.api,
      resume: chat.codex[app] || null,
    });
    if (r?.sessionId) chat.codex[app] = r.sessionId;
    else if (r?.resumeFailed) delete chat.codex[app];
    return;
  }

  const api = apiTurnConfig(ai, { gateway: DEFAULT_GATEWAY });
  if (!api) throw new Error("No AI is set up yet.");
  const { provider, creds, model } = api;

  // One stored history per chat and provider family: thinking blocks from
  // one provider mean nothing to another.
  const family = provider.name;
  if (chat.apiFamily && chat.apiFamily !== family) chats.resetApiHistory(chat.id);
  chat.apiFamily = family;

  await runTurn({
    app,
    history: chats.loadApiHistory(chat.id),
    userText: text,
    images,
    emit,
    signal,
    provider,
    creds,
    model,
    effort: lvl.api,
    save: (messages) => chats.saveApiHistory(chat.id, messages),
  });
}
