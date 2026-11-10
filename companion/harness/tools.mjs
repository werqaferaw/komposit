// The tools on this computer: the schemas for its modifier key (core/tools.mjs
// holds them, shared with the web page) and executeTool, which runs one call
// against an app's bridge. Each tool maps 1:1 to a bridge method.
import platform from "../platform/index.mjs";
import * as core from "./core/tools.mjs";

const mod = platform.keys.mod; // Cmd on a Mac, Ctrl on Windows

export const toolSchemas = (bridge) => core.toolSchemas(bridge, { mod });
export const allToolSchemas = () => core.allToolSchemas({ mod });
export const validateToolInput = core.validateToolInput;

// Execute one tool call against the bridge. Returns the Anthropic tool_result
// `content` (text + optional image block) plus a compact `display` for the UI.
export async function executeTool(bridge, name, input = {}) {
  try {
    if (name === "inspect") {
      const r = await bridge.inspect();
      let text = r.text;
      if (bridge.selection) {
        const s = await bridge.selection().catch(() => null);
        if (s?.summary) text += `\n\nCurrent selection:\n${s.summary}`;
      }
      return imageResult(text, r.image, { display: "inspected the document", image: r.image });
    }
    if (name === "edit") {
      const r = await bridge.edit(input.code || "");
      const logs = r.logs && r.logs.length ? `\nlogs: ${r.logs.join(" | ")}` : "";
      if (!r.ok) return errorResult(`edit failed: ${r.error}${logs}`, { display: `edit failed: ${r.error}` });
      const data = r.result != null ? `\nresult: ${JSON.stringify(r.result)}` : "";
      return textResult(`edit applied.${data}${logs}`, { display: input.explanation || "applied an edit" });
    }
    if (name === "render") {
      const r = await bridge.render(input);
      // The video plays in the chat (the app moves it there by this path); the
      // path itself is a temporary file the person never needs to see.
      const text = `Rendered (${r.note}).${r.video ? `\nPreview video: ${r.video}\nIt plays in the chat for the user; don't mention this temporary path.` : ""}`;
      const meta = { display: r.video ? `rendered a preview video ${r.video}` : "rendered to check", image: r.image, ...(r.video ? { video: r.video } : {}) };
      if (r.images && r.images.length > 1) {
        const content = [{ type: "text", text }];
        for (const im of r.images) content.push({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } });
        return { content, is_error: false, meta };
      }
      return imageResult(text, r.image, meta);
    }
    if (name === "export") {
      const cap = bridge.capabilities?.export || [];
      const f = String(input.format || "png").toLowerCase();
      if (!cap.includes(f)) {
        return errorResult(
          `export failed: ${bridge.label} can export ${cap.join(", ") || "nothing"}, not ${f}. Tell the user plainly and offer a supported format, or the manual steps in ${bridge.label}.`,
          { display: `can't export ${f} from ${bridge.label}` },
        );
      }
      const r = await bridge.exportCopy(input);
      return report("export", { ok: true, ...r }, { display: `exported ${r.path}` });
    }
    if (name === "save") {
      const modes = bridge.capabilities?.save || [];
      const mode = input.mode || "overwrite";
      if (!bridge.saveDocument || !modes.includes(mode)) {
        return errorResult(
          `save failed: ${bridge.label} supports ${modes.length ? modes.join(" and ") : "no"} saving from Komposit, not "${mode}". Tell the user and offer what works (or File > Save in ${bridge.label}).`,
          { display: `can't ${mode === "copy" ? "save a copy" : "save"} in ${bridge.label}` },
        );
      }
      const r = await bridge.saveDocument(input);
      return report("save", { ok: true, ...r }, { display: `saved ${r.path}` });
    }
    if (name === "preflight") {
      if (!bridge.preflight) return errorResult(`preflight is available in Illustrator only, not ${bridge.label}.`, { display: "no preflight here" });
      const r = await bridge.preflight();
      return report("preflight", { ok: true, ...r }, { display: "checked print readiness" });
    }
    if (name === "undo") {
      const r = await bridge.undo();
      return r.ok
        ? textResult("Undone one step.", { display: "undid last edit" })
        : errorResult(`undo failed: ${r.error}`, { display: "undo failed" });
    }
    return errorResult(`Unknown tool: ${name}`, { display: `unknown tool ${name}` });
  } catch (e) {
    const hint = name === "export" || name === "save" ? " Nothing was written. Tell the user honestly and give the manual steps in the app, or offer another format." : "";
    return errorResult(`${name} failed: ${e.message}.${hint}`, { display: `${name} error` });
  }
}

// Structured result for file-writing tools: success, path, what it is, warnings.
function report(tool, data, meta = {}) {
  return { content: `${tool} result: ${JSON.stringify(data, null, 1)}`, is_error: false, meta };
}

function textResult(text, meta = {}) {
  return { content: text, is_error: false, meta };
}
function errorResult(text, meta = {}) {
  return { content: text, is_error: true, meta };
}
function imageResult(text, image, meta = {}) {
  const content = [{ type: "text", text }];
  if (image) content.push({ type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } });
  return { content, is_error: false, meta };
}
