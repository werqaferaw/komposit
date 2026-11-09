// The API engine's harness. One turn = the model driving the live document in
// a loop: look, edit, check, adjust, until it is done. Every step streams out
// through `emit` so the UI shows what is happening.
//
// Pure: no Node APIs. The same loop runs in the local server (harness/loop.mjs
// wires it to the bridges on this computer) and in the web page, where
// `runTool` calls the app's POST /api/tool and the model is called straight
// from the browser.
//
// The conversation history is APPEND-ONLY. Earlier messages, including the
// model's thinking blocks, go back to the API exactly as they came, and the
// system prompt and tool list never change during a chat. That is what keeps
// Claude Opus 5.5's earlier reasoning valid between turns (editing history is
// a 400 on newer accounts) and keeps the prompt cache hitting, which also
// makes the screenshots already in the history cheap to re-send.
import { allToolSchemas, validateToolInput } from "./tools.mjs";
import { buildSystem } from "./system.mjs";

const APP_NAMES = { illustrator: "Illustrator", photoshop: "Photoshop", aftereffects: "After Effects" };

// Run one turn. `history` is the stored message array for this chat (never
// edited in place); `save(messages)` persists it after every step.
// `runTool(name, input, { id })` runs one validated tool call on the computer
// with the apps and resolves to { content, is_error, meta: { display, image?,
// video? } }. `mod` is that computer's modifier key (Cmd / Ctrl), which the
// prompt and the tool descriptions mention. Returns the full message array.
export async function runTurn({
  app,
  history = [],
  userText,
  images = [],
  emit = () => {},
  signal,
  provider,
  creds,
  model,
  effort = "medium",
  runTool,
  mod = "Cmd",
  save = () => {},
  maxToolCalls = 40,
}) {
  const tools = allToolSchemas({ mod });
  const system = buildSystem(undefined, { mod });

  const userContent = [];
  for (const img of images) {
    userContent.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
  }
  userContent.push({ type: "text", text: `[App: ${APP_NAMES[app] || app}]\n\n${userText || "(see the attached image)"}` });

  const messages = history.slice();
  const last = messages[messages.length - 1];
  if (last && last.role === "user") {
    // A previous turn ended before the model answered (stopped, refused, or an
    // error). Nothing follows that message, so adding to it edits no thinking.
    const prev = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
    messages[messages.length - 1] = { role: "user", content: [...prev, ...userContent] };
  } else {
    messages.push({ role: "user", content: userContent });
  }
  save(messages);

  let toolCalls = 0;
  let modelMs = 0;

  for (;;) {
    if (signal?.aborted) {
      emit({ type: "aborted" });
      break;
    }

    // Live progress: thinking blocks under display "updates" are short notes;
    // text streams as it is written.
    const thinkingBuf = new Map(); // block index -> text
    const t0 = Date.now();
    let res;
    try {
      res = await provider.stream({
        system,
        messages,
        tools,
        model,
        effort,
        creds,
        signal,
        onEvent: (e) => {
          if (e.type === "text") emit({ type: "text", delta: e.delta });
          else if (e.type === "thinking" && provider.thinkingIsProgress) {
            thinkingBuf.set(e.index, (thinkingBuf.get(e.index) || "") + e.delta);
          } else if (e.type === "block_stop" && thinkingBuf.has(e.index)) {
            emit({ type: "note", text: thinkingBuf.get(e.index) });
            thinkingBuf.delete(e.index);
          }
        },
      });
    } catch (e) {
      modelMs += Date.now() - t0;
      if (signal?.aborted) {
        emit({ type: "aborted" });
        break;
      }
      const err = provider.explainError ? provider.explainError(e) : { message: e.message };
      emit({ type: "error", message: err.message, code: err.code });
      break;
    }
    modelMs += Date.now() - t0;

    const content = Array.isArray(res.content) ? res.content : [];
    const toolUses = content.filter((b) => b.type === "tool_use");

    if (res.stopReason === "refusal") {
      // Declined even after the server-side fallback. Discard the partial
      // response; the history still ends on the user's side.
      emit({ type: "refusal" });
      break;
    }
    if (res.stopReason === "max_tokens" && toolUses.length) {
      emit({ type: "error", message: "The response was cut off before its next step. Try a smaller request.", code: "max_tokens" });
      break;
    }

    // Keep the model's message exactly as it came (thinking included).
    const assistantContent = provider.keepsThinking
      ? content
      : content.filter((b) => b.type === "text" || b.type === "tool_use");
    messages.push({ role: "assistant", content: assistantContent });

    const texts = content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();

    if (!toolUses.length) {
      save(messages);
      emit({ type: "final", text: texts });
      break;
    }
    if (texts) emit({ type: "note", text: texts });

    const results = [];
    for (const tu of toolUses) {
      if (signal?.aborted) {
        results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: "Stopped by the user." });
        continue;
      }
      if (toolCalls >= maxToolCalls) {
        results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: "Tool-call limit reached for this message." });
        continue;
      }
      const invalid = validateToolInput(tu.name, tu.input);
      if (invalid) {
        emit({ type: "tool_run", id: tu.id, name: tu.name, input: {} });
        emit({ type: "tool_done", id: tu.id, name: tu.name, is_error: true, display: invalid });
        results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: `INVALID_INPUT: ${invalid}. Send the call again with complete input.` });
        continue;
      }
      toolCalls++;
      emit({ type: "tool_run", id: tu.id, name: tu.name, input: tu.input });
      const r = await runTool(tu.name, tu.input, { id: tu.id });
      emit({
        type: "tool_done",
        id: tu.id,
        name: tu.name,
        display: r.meta.display,
        image: r.meta.image || null,
        video: r.meta.video || null,
        is_error: r.is_error,
      });
      results.push({ type: "tool_result", tool_use_id: tu.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
    save(messages);

    if (signal?.aborted) {
      emit({ type: "aborted" });
      break;
    }
    if (toolCalls >= maxToolCalls) {
      emit({ type: "final", text: "I stopped at the step limit for one message. Say “continue” to keep going." });
      break;
    }
  }

  emit({ type: "timing", modelMs });
  return messages;
}
