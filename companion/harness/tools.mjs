// The tools the agent drives the live document with. Each maps 1:1 to a bridge
// method. The API engine offers the SAME tool list for every app: changing the
// tool list mid-conversation would invalidate the cached prefix and the
// model's earlier thinking. Unsupported calls just return an error.
import platform from "../platform/index.mjs";

const MOD = platform.keys.mod; // Cmd on a Mac, Ctrl on Windows

const ALL = {
  inspect: {
    name: "inspect",
    description:
      "Inspect the active document: a structured state map (layers, items, bounds, colors, fonts; each item carries a `ref` usable verbatim in an edit), the current selection, plus a screenshot. Read-only. Use it when you need to know what's there or where something is; skip it when you already know.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  edit: {
    name: "edit",
    description:
      "Run ExtendScript (ES3, no modern JS) against the active document. Changes land in the app's undo history and are NOT saved. Never call save(), saveAs() or close() in a script: use the save tool. " +
      "READ data back by `return`ing it: it comes to you as `result:` (and `log(x)` → `logs:`). Never throw an error to surface a value. A failure returns `edit failed: <message> (line N)`. " +
      "Batch: one script can make several related changes and return what you need to verify. Avoid separate probe calls.",
    input_schema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The ExtendScript to execute against the active document." },
        explanation: { type: "string", description: "One short line: what this edit does." },
      },
      required: ["code"],
    },
  },
  render: {
    name: "render",
    description:
      "Render the active artboard (Illustrator), the document (Photoshop) or the current comp frame (After Effects) to an image so you can see the result. Read-only. Use it when a change is visual and worth verifying. " +
      "After Effects, for animation: frames (2-8) returns that many frames spread across the work area so you can check the motion; video: true also renders a short half-resolution MP4 preview of the work area (up to 10 s) that plays in the chat for the user. " +
      "The video takes a render-queue pass, so use it once, when an animation is done or the user wants to see it move.",
    input_schema: {
      type: "object",
      properties: {
        frames: { type: "number", description: "After Effects only: how many frames across the work area (1-8). Default 1, the current frame." },
        video: { type: "boolean", description: "After Effects only: also make a short MP4 preview the user can watch in the chat." },
      },
      required: [],
    },
  },
  export: {
    name: "export",
    description:
      "Write a NEW file from the active document, for the user to use. Formats: Illustrator png, jpg, svg, pdf; Photoshop png, jpg; After Effects png (the current comp frame) and mp4 (H.264 of the work area, full size, through the render queue). " +
      "Writes to ~/Komposit Exports unless outputDir is given (must be inside the home folder). Never overwrites: an existing name gets a number added. " +
      "Leaves the open document as it was: same name, same path, same unsaved state. Returns the full path, a note on what the file is good for, and warnings. " +
      "PDF (Illustrator only): made from a copy of the document with Adobe's PDF presets; defaults to [PDF/X-4:2008], 3 mm bleed and crop marks, all artboards (print-ready). " +
      "For a PDF to share on screen, use preset \"[Smallest File Size]\", bleedMm 0 and cropMarks false. PNG and JPG are the active artboard, for screens, not print. " +
      "Use only when the user asks for a file.",
    input_schema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["png", "jpg", "svg", "pdf", "mp4"], description: "Output format. Check the per-app list above." },
        name: { type: "string", description: "Base filename, without extension. Defaults to the document's name." },
        outputDir: { type: "string", description: "Folder to write into, inside the home folder (~ allowed). Defaults to ~/Komposit Exports." },
        preset: { type: "string", description: "PDF only. An Adobe PDF preset name, e.g. [PDF/X-4:2008], [Press Quality], [High Quality Print], [Smallest File Size]." },
        bleedMm: { type: "number", description: "PDF only. Bleed on every side in millimetres. Default 3." },
        cropMarks: { type: "boolean", description: "PDF only. Add crop (trim) marks. Default true." },
        artboards: { type: "string", description: "PDF only. Artboard range like \"1\" or \"1-3,5\". Default: all." },
      },
      required: ["format"],
    },
  },
  save: {
    name: "save",
    description:
      "Save the active document. Only when the user asks to save; never after edits on your own. " +
      `mode "overwrite": save the file itself, like ${MOD}+S (what "save" means). A document that was never saved can't be overwritten; save a copy instead. ` +
      "mode \"copy\": write a new file in the app's own format (.ai, .psd) to ~/Komposit Exports or outputDir, never overwriting another file, and leave the open document as it is. " +
      "After Effects supports overwrite only. Returns the path and what was saved.",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["overwrite", "copy"], description: "overwrite (save the file itself) or copy (a new file)." },
        name: { type: "string", description: "copy only: base filename, without extension. Defaults to '<document> copy'." },
        outputDir: { type: "string", description: "copy only: folder inside the home folder. Defaults to ~/Komposit Exports." },
      },
      required: ["mode"],
    },
  },
  preflight: {
    name: "preflight",
    description:
      "Illustrator only. Read-only print check of the active document: colour mode, artboard sizes in mm, fonts (and missing ones), linked and missing images, art off or across the artboard edges, spot colours, hidden and non-printing layers, effects resolution. Returns findings and warnings. Use when the user asks whether a file is ready for print.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  undo: {
    name: "undo",
    description: "Undo the last edit in the host app (one step). Use to back out a change you can see went wrong.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
};

// The tool list offered for a given app, trimmed to what it supports (used by
// the MCP doc server, where each server instance serves one app).
export function toolSchemas(bridge) {
  const cap = bridge.capabilities || {};
  const out = [];
  if (cap.inspect) out.push(ALL.inspect);
  if (cap.edit) out.push(ALL.edit, ALL.undo);
  if (cap.render) out.push(ALL.render);
  if (cap.export && cap.export.length) out.push(ALL.export);
  if (cap.save && cap.save.length) out.push(ALL.save);
  if (cap.preflight) out.push(ALL.preflight);
  return out;
}

// The fixed tool list for the API engine (same for every app, same order).
export function allToolSchemas() {
  return [ALL.inspect, ALL.edit, ALL.undo, ALL.render, ALL.export, ALL.save, ALL.preflight];
}

// Tool inputs are streamed eagerly, and a tolerant parser can hand back a
// truncated object, so check each input against its schema before running it.
// Returns null when valid, else a short reason.
export function validateToolInput(name, input) {
  const tool = ALL[name];
  if (!tool) return `unknown tool ${name}`;
  if (!input || typeof input !== "object" || Array.isArray(input)) return "input must be an object";
  if (input.__invalid_json !== undefined) return "input was not valid JSON";
  const props = tool.input_schema.properties || {};
  for (const req of tool.input_schema.required || []) {
    if (input[req] === undefined || input[req] === null || input[req] === "") return `missing "${req}"`;
  }
  for (const [k, v] of Object.entries(input)) {
    const spec = props[k];
    if (!spec) continue;
    if (spec.type === "string" && typeof v !== "string") return `"${k}" must be a string`;
    if (spec.type === "number" && (typeof v !== "number" || !Number.isFinite(v))) return `"${k}" must be a number`;
    if (spec.type === "boolean" && typeof v !== "boolean") return `"${k}" must be true or false`;
    if (spec.enum && !spec.enum.includes(v)) return `"${k}" must be one of ${spec.enum.join(", ")}`;
  }
  return null;
}

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
      const text = `Rendered (${r.note}).${r.video ? `\nPreview video: ${r.video}` : ""}`;
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
