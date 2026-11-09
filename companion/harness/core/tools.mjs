// The tools the agent drives the live document with: their schemas and the
// input check. Pure (no Node APIs): the local server and the web page offer the
// model the very same list. Running a tool happens on the computer with the
// Adobe apps (tools.mjs executeTool, reached from the page through the
// bridge's POST /api/tool).
//
// The API engine offers the SAME tool list for every app: changing the tool
// list mid-conversation would invalidate the cached prefix and the model's
// earlier thinking. Unsupported calls just return an error. `mod` is the
// modifier key on the computer the apps run on ("Cmd" on a Mac, "Ctrl" on Windows).

function defs(MOD) {
  return {
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
}

const BY_MOD = new Map();
function all(mod = "Cmd") {
  if (!BY_MOD.has(mod)) BY_MOD.set(mod, defs(mod));
  return BY_MOD.get(mod);
}

// The tool list offered for a given app, trimmed to what it supports (used by
// the MCP doc server, where each server instance serves one app).
export function toolSchemas(bridge, { mod } = {}) {
  const ALL = all(mod);
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
export function allToolSchemas({ mod } = {}) {
  const ALL = all(mod);
  return [ALL.inspect, ALL.edit, ALL.undo, ALL.render, ALL.export, ALL.save, ALL.preflight];
}

// Tool inputs are streamed eagerly, and a tolerant parser can hand back a
// truncated object, so check each input against its schema before running it.
// Returns null when valid, else a short reason.
export function validateToolInput(name, input) {
  const tool = all()[name];
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
