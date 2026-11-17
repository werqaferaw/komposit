// The tools every AI gets: their names, descriptions and input schemas, plus the input
// check. Ported from 1.0 with the SAME names and inputs, because the prompts and the app
// recipes depend on them. App tools take "app" (required when the run may use more than one
// app) and an optional "doc" ({ name, path }) so a call targets a document, never "whatever
// is in front".
//
// Shared by the Komposit app and the standalone MCP server (mcp/). The list stays the same
// for a whole conversation (changing it mid-conversation breaks the AI's cached prefix).
// Unsupported calls just return a plain error.
import type { ToolDef } from "../protocol/tools.ts";
import type { ConnectorManifest } from "../protocol/connector.ts";

type Schema = Record<string, any>;

const NOTES_NAME = "komposit-notes.md";
const EXPORTS_NAME = "Exports";

export interface AppToolOptions {
  /** What happens to edit code the script check flags: the Komposit app asks the person
   *  ("ask", the default); the standalone MCP server refuses it ("refuse"). */
  scripts?: "ask" | "refuse";
  /** The Komposit app's extras for edit: helpers kept for the chat, and a render in the same
   *  call. The standalone MCP server has no chat to keep helpers in. */
  chat?: boolean;
}

const SCRIPT_RULE = {
  ask: "Code that reaches outside the document (deleting files, running shell commands, quitting the app, closing a document without saving) asks the user first.",
  refuse:
    "Code that reaches outside the document (deleting, renaming or running files, shell commands, quitting the app, closing a document without saving) or saves the document is refused with a plain explanation: use the save and export tools instead.",
};

/** The app tools by name, with `mod` (Cmd or Ctrl) in the save description. */
export function appToolDefs(MOD: string, opts: AppToolOptions = {}): Record<string, ToolDef> {
  return {
    inspect: {
      name: "inspect",
      appScoped: true,
      readOnly: true,
      description:
        "Inspect the document: a structured state map (layers, items, bounds, colors, fonts; each item carries a `ref` usable verbatim in an edit), the current selection, plus a screenshot. Read-only. Use it when you need to know what's there or where something is; skip it when you already know.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    edit: {
      name: "edit",
      appScoped: true,
      description:
        "Run code in the app's own scripting language against the document (ExtendScript, ES3, no modern JS, for Illustrator, Photoshop, After Effects and Premiere Pro: no arrow functions, no template strings, no map/forEach/filter on arrays; JSON.stringify and JSON.parse work). Changes land in the app's undo history and are NOT saved. Never call save(), saveAs() or close() in a script: use the save tool. " +
        "READ data back by `return`ing it: it comes to you as `result:` (and `log(x)` → `logs:`). Never throw an error to surface a value. A failure returns `edit failed: <message> (line N)`, N counted in your code. " +
        "Batch: one script can make several related changes and return what you need to verify. Avoid separate probe calls. " +
        (opts.chat
          ? "Helpers: put functions and values you'll use again (drawing helpers, colors, lookups) in `helpers`, not in `code`. Komposit keeps them for this chat in this app and puts them in front of this edit's code and every later one's, so define them once and afterwards just call them: never send them again. A helper with the same name replaces the old one. " +
            "To see the result, pass render: true instead of calling render next: the picture comes back with this edit. "
          : "") +
        SCRIPT_RULE[opts.scripts || "ask"],
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "The code to execute against the document." },
          explanation: { type: "string", description: "One short line: what this edit does." },
          ...(opts.chat
            ? {
                helpers: {
                  type: "string",
                  description:
                    "Function declarations and var lines to keep for later edits in this app in this chat (e.g. function rgb(r,g,b){...} var INK = rgb(20,20,20);). Kept before the code runs, available in this code and every later edit's. Same name replaces. Up to 32 KB in all.",
                },
                render: { type: "boolean", description: "Also render the result after the edit and return the picture (one call instead of edit then render)." },
              }
            : {}),
        },
        required: ["code"],
      },
    },
    undo: {
      name: "undo",
      appScoped: true,
      description: "Undo your last edit in the document (one step; each edit is one undo step, named after its explanation where the app allows). Use to back out a change you can see went wrong. It only takes back Komposit's own changes: when the latest step may be the user's own work (they've worked in the app since, or the app's history says so), nothing is undone and it says why. Then tell the user, or make a new edit that puts it back.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    render: {
      name: "render",
      appScoped: true,
      readOnly: true,
      description:
        "Render the active artboard (Illustrator), the document (Photoshop), the current frame of the comp being worked in (After Effects) or the frame at the playhead of the sequence being worked in (Premiere Pro) to an image so you can see the result. Read-only. Use it when a change is visual and worth verifying. " +
        "After Effects, for animation: frames (2-8) returns that many frames spread across the work area so you can check the motion; video: true also renders a short half-resolution MP4 preview of the work area (up to 10 s) that plays in the chat for the user. " +
        "Premiere Pro: frames (2-8) spreads them across the sequence (or its in/out range) to check an edit; video: true makes a short low-bitrate MP4 (up to 10 s around the playhead). " +
        "Premiere Pro, to WATCH a stretch instead of spot-checking it: pass every (seconds between frames, e.g. 0.1) with from and to. You get contact sheets (up to 96 frames a call, each with its time under it) and a list of which clip, and which part of its source, every frame comes from. " +
        "Use it whenever something has to be found or ruled out across a stretch (a person, a logo, a bad take): a shot shorter than the gap between frames is never seen, so keep every shorter than the shortest shot (0.1 for a fast cut). Add detail: true for larger frames when the thing is small. To see what the source footage holds before choosing a replacement, open the sequence that has the whole take and watch that. " +
        "The video takes a render-queue pass, so use it once, when an animation is done or the user wants to see it move.",
      inputSchema: {
        type: "object",
        properties: {
          frames: { type: "number", description: "After Effects and Premiere Pro: how many frames across the work area or sequence (1-8). Default 1, the current frame. Premiere Pro: more than 8 (up to 96) gives contact sheets." },
          every: { type: "number", description: "Premiere Pro: watch the stretch with a frame every this many seconds (contact sheets)." },
          from: { type: "number", description: "Premiere Pro: where the stretch to watch starts, in seconds (default: the in point or the start)." },
          to: { type: "number", description: "Premiere Pro: where it ends, in seconds (default: the out point or the end)." },
          detail: { type: "boolean", description: "Premiere Pro: larger frames on the contact sheets (fewer per sheet)." },
          video: { type: "boolean", description: "After Effects and Premiere Pro: also make a short MP4 preview the user can watch in the chat." },
        },
        required: [],
      },
    },
    export: {
      name: "export",
      appScoped: true,
      description:
        "Write a NEW file from the document, for the user to use. Formats: Illustrator png, jpg, svg, pdf; Photoshop png, jpg; After Effects png (the current frame of the comp being worked in) and mp4 (H.264 of the work area, full size, through the render queue); Premiere Pro png (the frame at the playhead) and mp4 (H.264 of the sequence being worked in, or its in/out range, matching its settings). " +
        "Writes to ~/Komposit Exports (in a project: its Exports folder) unless outputDir is given (must be inside the home folder or the project). Never overwrites: an existing name gets a number added. " +
        "Leaves the open document as it was: same name, same path, same unsaved state. Returns the full path, a note on what the file is good for, and warnings. " +
        "PDF (Illustrator only): made from a copy of the document with Adobe's PDF presets; defaults to [PDF/X-4:2008], 3 mm bleed and crop marks, all artboards (print-ready). " +
        "For a PDF to share on screen, use preset \"[Smallest File Size]\", bleedMm 0 and cropMarks false. PNG and JPG are the active artboard, for screens, not print. " +
        "For files the user asks for.",
      inputSchema: {
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
      appScoped: true,
      description:
        "Save the document, when the user asks (or, in a project, to give a new piece its file). " +
        `mode "overwrite": save the file itself, like ${MOD}+S (what "save" means). A document that was never saved can't be overwritten; save a copy instead. ` +
        "mode \"copy\": write a new file in the app's own format (.ai, .psd) to ~/Komposit Exports or outputDir, never overwriting another file, and leave the open document as it is. " +
        "mode \"as\": save the document as a new file (.ai, .psd) in outputDir, never overwriting another file; the open document becomes that file, so later saves go there (a new document that should be kept somewhere). " +
        "After Effects supports overwrite only. Premiere Pro: copy writes the sequence being worked in and the media it uses as a new .prproj (other sequences aren't in it), and as moves the open project to the new file; every Premiere Pro save needs doc. Returns the path and what was saved.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["overwrite", "copy", "as"], description: "overwrite (save the file itself), copy (a new file), or as (save as a new file and keep working in it)." },
          name: { type: "string", description: "copy and as: base filename, without extension. Defaults to '<document> copy' (copy) or the document's name (as)." },
          outputDir: { type: "string", description: "copy and as: folder inside the home folder. Defaults to ~/Komposit Exports." },
        },
        required: ["mode"],
      },
    },
    preflight: {
      name: "preflight",
      appScoped: true,
      readOnly: true,
      description:
        "Illustrator only. Read-only print check of the document: colour mode, artboard sizes in mm, fonts (and missing ones), linked and missing images, art off or across the artboard edges, spot colours, hidden and non-printing layers, effects resolution. Returns findings and warnings. Use when the user asks whether a file is ready for print.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    dialog: {
      name: "dialog",
      appScoped: true,
      description:
        "For when the app is showing a dialog (a step said so, or a script didn't come back): a dialog blocks every script until it is answered. " +
        "With no input: what the dialog says, its title, its text and its buttons. " +
        "With `press`: answer it, with a button's name exactly as listed, or \"escape\" for the Esc key. " +
        "Press only what acknowledges or cancels (OK, Cancel, Close, Continue). A button that saves, throws away, replaces or deletes the person's work is theirs to press: say what the dialog asks and which buttons it has, and they answer it in the app. " +
        "Only a dialog your own step caused can be answered: one that was up before the step, or came up while the person was working in the app, is theirs (the read says theirs: true), and pressing is refused; wait for them, and the step carries on when it closes. " +
        "When the dialog can't be read, say so plainly: the person sees a picture of it in the chat.",
      inputSchema: {
        type: "object",
        properties: { press: { type: "string", description: "A button's name as listed, or \"escape\". Leave out to only read the dialog." } },
        required: [],
      },
    },
    place: {
      name: "place",
      appScoped: true,
      description:
        "Bring a file into an app's open document, using that app's own importer. Photoshop: placed as a smart object (embedded; pass linked: true to keep it linked to the file). " +
        "Illustrator: placed on the active artboard (linked; pass linked: false to embed it). After Effects: imported into the project (a layered .psd or .ai comes in as a composition) " +
        "and added to the comp being worked in. Premiere Pro: imported into the project (a layered .psd comes in flattened) and put on the sequence being worked in at its playhead, on the lowest video track that's free there (pass addToSequence: false to only import). " +
        "Use it to hand work from one app to another: place a document's own saved path, or a file that export or save wrote.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path of the file to bring in." },
          linked: { type: "boolean", description: "Photoshop and Illustrator: keep it linked to the file instead of embedded." },
          asComp: { type: "boolean", description: "After Effects: bring a layered .psd or .ai in as a composition (default true)." },
          addToComp: { type: "boolean", description: "After Effects: also add it to the open composition (default true)." },
          addToSequence: { type: "boolean", description: "Premiere Pro: also put it on the sequence being worked in at its playhead (default true)." },
        },
        required: ["path"],
      },
    },
    open: {
      name: "open",
      appScoped: true,
      description:
        "Open a file in Illustrator or Photoshop and make it the active document (if it's already open, bring it to the front), or a Premiere Pro project (.prproj) in Premiere Pro. " +
        "After Effects keeps one project open: bring files into it with place. Media for Premiere (footage, audio, stills) goes in with place.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path of the file to open." } },
        required: ["path"],
      },
    },
    guide: {
      name: "guide",
      appScoped: true,
      readOnly: true,
      description:
        "Known-good recipes for an app, tested and exact: build edits on them. With no topic: the list of topics. Use it before writing code for something you haven't done in this app yet.",
      inputSchema: {
        type: "object",
        properties: { topic: { type: "string", description: "A topic from the list. Leave out to get the list." } },
        required: [],
      },
    },
  };
}

const pathProp = (what: string) => ({ type: "string", description: `${what}: relative to the project folder, or absolute inside it.` });

// ask works in every chat; the rest work on a project's folder (no "app" argument).
export const PROJECT_TOOLS: Record<string, ToolDef> = {
  ask: {
    name: "ask",
    readOnly: true,
    description:
      "Ask the user to decide, when the choice is genuinely theirs: which file types to export, which of two directions, a fact the brief leaves open. " +
      "Shows your question in the chat with your options and waits for the answer. Mark the option(s) you recommend. " +
      "Don't ask what the brief or the user already answered, and don't use it to report progress.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "One short question." },
        options: {
          type: "array",
          description: "2 to 8 options, most useful first.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "A few words, e.g. \"Print PDF\"." },
              description: { type: "string", description: "Optional: one short line on what it's for." },
              recommended: { type: "boolean", description: "Your recommendation." },
            },
            required: ["label"],
          },
        },
        multiple: { type: "boolean", description: "They may pick several (e.g. file types)." },
        allowOther: { type: "boolean", description: "They may type their own answer instead (default true)." },
      },
      required: ["question", "options"],
    },
  },
  write_file: {
    name: "write_file",
    description:
      `Create or replace a TEXT file in the project folder (notes, copy decks, a brief, CSV, SVG markup). Asks the user first unless they allowed writing in this project; ${NOTES_NAME} and anything in ${EXPORTS_NAME}/ never ask. ` +
      "Design files (.ai, .psd, .aep, .pdf) are made by their app: use save or export.",
    inputSchema: {
      type: "object",
      properties: { path: pathProp("The file"), content: { type: "string", description: "The whole new content." } },
      required: ["path", "content"],
    },
  },
  make_folder: {
    name: "make_folder",
    description: `Make a folder in the project (and any missing folders above it). Asks first unless allowed; inside ${EXPORTS_NAME}/ it doesn't.`,
    inputSchema: { type: "object", properties: { path: pathProp("The folder") }, required: ["path"] },
  },
  copy: {
    name: "copy",
    description: "Copy a file or folder within the project, e.g. to keep a version before a big change. Never replaces anything that exists. Asks first unless writing is allowed.",
    inputSchema: { type: "object", properties: { from: pathProp("What to copy"), to: pathProp("The new path (not an existing one)") }, required: ["from", "to"] },
  },
  move: {
    name: "move",
    description: "Move or rename a file or folder within the project. Never replaces anything that exists. Asks first unless moving is allowed in this project. Don't move a file that's open in an app.",
    inputSchema: { type: "object", properties: { from: pathProp("What to move"), to: pathProp("The new path (not an existing one)") }, required: ["from", "to"] },
  },
  trash: {
    name: "trash",
    description: "Move files or folders in the project to the Trash (the user can put them back). Asks first unless deleting is allowed in this project. Only when the user wants them gone.",
    inputSchema: {
      type: "object",
      properties: { paths: { type: "array", items: { type: "string" }, description: "Files or folders: relative to the project folder, or absolute inside it." } },
      required: ["paths"],
    },
  },
  find_files: {
    name: "find_files",
    readOnly: true,
    description: "List files in the project: all of them, or those matching a pattern (\"*.ai\", \"**/poster*\", or a plain word to match anywhere in the path). Newest first, with size and date.",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string", description: "Glob or word. Empty: everything." }, under: { type: "string", description: "Only inside this subfolder." } },
      required: [],
    },
  },
  read_file: {
    name: "read_file",
    readOnly: true,
    description: "Read a file in the project: text (lines from offset, up to limit), or an image (PNG, JPG, WebP, GIF), which you see. For a PDF, a design file or a video, open it in its app.",
    inputSchema: {
      type: "object",
      properties: {
        path: pathProp("The file"),
        offset: { type: "number", description: "Text: the first line to read (1-based)." },
        limit: { type: "number", description: "Text: how many lines (default 400)." },
      },
      required: ["path"],
    },
  },
};

export const APP_TOOL_ORDER = ["inspect", "edit", "undo", "render", "export", "save", "preflight", "dialog", "place", "open", "guide"];
/** Tools every run gets, whatever the apps. */
export const GENERAL_TOOL_ORDER = ["ask"];
export const PROJECT_TOOL_ORDER = ["write_file", "make_folder", "copy", "move", "trash", "find_files", "read_file"];
/** Tools that change the document: the scheduler gives the chat a hold on it. */
export const WRITING_TOOLS = new Set(["edit", "undo", "save", "place"]);

/** Which app tools any loaded connector can do (the list then stays fixed for the process). */
export function supportedAppTools(manifests: ConnectorManifest[]): Set<string> {
  const out = new Set<string>();
  for (const m of manifests) {
    const c = m.capabilities;
    if (c.inspect) out.add("inspect");
    if (c.run) out.add("edit");
    if (c.undo) out.add("undo");
    if (c.render) out.add("render");
    if (c.export?.length) out.add("export");
    if (c.save?.length) out.add("save");
    if (c.preflight) out.add("preflight");
    if (c.dialog) out.add("dialog");
    if (c.place) out.add("place");
    if (c.open) out.add("open");
    out.add("guide");
  }
  return out;
}

export interface ListOptions {
  /** Cmd or Ctrl. */
  mod: string;
  /** Every app id there's a connector for. */
  appIds: string[];
  /** App tools offered (supportedAppTools). */
  supported: Set<string>;
  /** The run may use more than one app: "app" is required. */
  multiApp: boolean;
  /** Apps left out in the app switch (calls to them are refused). */
  offApps?: string[];
  /** The run works in a project folder: the project tools too. */
  project: boolean;
}

/** The tools for one run, in a fixed order. */
export function toolList(opts: ListOptions): ToolDef[] {
  const app = appToolDefs(opts.mod, { chat: true });
  const out: ToolDef[] = [];
  for (const name of APP_TOOL_ORDER) {
    if (!opts.supported.has(name)) continue;
    out.push(withTarget(app[name]!, { ...opts, request: true }));
  }
  for (const name of GENERAL_TOOL_ORDER) out.push(PROJECT_TOOLS[name]!);
  if (opts.project) for (const name of PROJECT_TOOL_ORDER) out.push(PROJECT_TOOLS[name]!);
  return out;
}

/** Every tool name the toolbox can serve (for allow-lists). */
export function allToolNames(supported: Set<string>): string[] {
  return APP_TOOL_ORDER.filter((n) => supported.has(n)).concat(GENERAL_TOOL_ORDER, PROJECT_TOOL_ORDER);
}

/** The definition of one tool, whatever the run (for checking a call's input). */
export function toolDef(name: string, opts: ListOptions): ToolDef | undefined {
  const app = appToolDefs(opts.mod, { chat: true });
  if (app[name]) return withTarget(app[name], { ...opts, request: true });
  return PROJECT_TOOLS[name];
}

/** What "doc" means in a Komposit request: fixed for the whole request (core/toolbox/execute.ts
 *  targetDoc). The standalone MCP server has no requests: there it's the active document. */
const REQUEST_DOC =
  "The document to act on: its name, and its path when it's saved (from the open-files list). Default: this request's document, the one the user pointed the message at, else the one in front when this request first worked in the app. It stays the same for the whole request, even when the user brings another file forward meanwhile (they may be working in it): to act on any other document, one you opened or made included, name it here on every call. If the request's document was closed, calls say so; don't carry on in another file on your own.";
const REQUEST_PART =
  "After Effects: a comp's name; Premiere Pro: a sequence's name. Default: the one this request works in (the one being viewed when it started, or a comp the request made when it had none). Name another to act on it; the user's viewer and timeline stay as they are.";

/** A tool with the "app" and "doc" arguments added. `request`: the Komposit app's wording, where
 *  a call with no doc acts on the request's document and doc can name a part (comp, sequence). */
export function withTarget(t: ToolDef, opts: Pick<ListOptions, "appIds" | "multiApp" | "offApps"> & { request?: boolean }): ToolDef {
  const schema = t.inputSchema as Schema;
  const off = opts.offApps?.length ? ` Off for this request (the user left them out in the app switch; calls are refused): ${opts.offApps.join(", ")}.` : "";
  return {
    ...t,
    inputSchema: {
      ...schema,
      properties: {
        ...(schema.properties || {}),
        app: {
          type: "string",
          enum: opts.appIds,
          description: (opts.multiApp ? "Which app to act in. Always pass it." : "Which app to act in. Optional: this chat has one app.") + off,
        },
        doc: {
          type: "object",
          description: opts.request ? REQUEST_DOC : "The document to act on: its name, and its path when it's saved (from the open-files list). Default: the app's active document.",
          properties: {
            name: { type: "string", description: "The document's name, as the app shows it." },
            path: { type: "string", description: "Its full path, when it's saved." },
            ...(opts.request ? { part: { type: "string", description: REQUEST_PART } } : {}),
          },
          required: ["name"],
        },
      },
      required: [...((schema.required as string[]) || []), ...(opts.multiApp ? ["app"] : [])],
    },
  };
}

// ---- the input check ----------------------------------------------------------------------
// Tool inputs can arrive truncated or mistyped, so each is checked against its schema before
// anything runs. Returns null when valid, else a short reason the AI can act on.

export function checkInput(schema: Schema, input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "the input must be an object";
  return checkObject(schema, input as Record<string, unknown>, "");
}

function checkObject(schema: Schema, obj: Record<string, unknown>, at: string): string | null {
  const props: Record<string, Schema> = schema.properties || {};
  for (const req of (schema.required as string[]) || []) {
    const v = obj[req];
    if (v === undefined || v === null || v === "") return `"${at}${req}" is missing`;
  }
  for (const [k, v] of Object.entries(obj)) {
    const spec = props[k];
    if (!spec || v === undefined || v === null) continue;
    const why = checkValue(spec, v, `${at}${k}`);
    if (why) return why;
  }
  return null;
}

function checkValue(spec: Schema, v: unknown, at: string): string | null {
  if (spec.type === "string" && typeof v !== "string") return `"${at}" must be text`;
  if (spec.type === "number" && (typeof v !== "number" || !Number.isFinite(v))) return `"${at}" must be a number`;
  if (spec.type === "boolean" && typeof v !== "boolean") return `"${at}" must be true or false`;
  if (spec.enum && !(spec.enum as unknown[]).includes(v)) return `"${at}" must be one of ${(spec.enum as unknown[]).join(", ")}`;
  if (spec.type === "array") {
    if (!Array.isArray(v)) return `"${at}" must be a list`;
    if (spec.items) {
      for (let i = 0; i < v.length; i++) {
        const why = checkValue(spec.items, v[i], `${at}[${i}]`);
        if (why) return why;
      }
    }
  }
  if (spec.type === "object") {
    if (typeof v !== "object" || Array.isArray(v)) return `"${at}" must be an object`;
    return checkObject(spec, v as Record<string, unknown>, `${at}.`);
  }
  return null;
}
