// Running one tool call. The rules are enforced here, in code:
//   - the input is checked against the tool's schema first (a plain error back to the AI);
//   - an app must be open: Komposit never starts one (a script sent to a closed app would);
//   - one call at a time per app (lanes.ts);
//   - exports never overwrite: a free name is picked before the app writes;
//   - nothing is saved unless the save tool is called: scripts that save are refused;
//   - scripts the toolkit's script check flags are refused, unless the person started the
//     server with KOMPOSIT_ALLOW_RISKY_SCRIPTS=1;
//   - pictures come back as MCP image content;
//   - listening to a file by its path is done on this computer and needs no app open.
import { basename, isAbsolute, resolve } from "node:path";
import type { AppStatus, DocRef } from "../protocol/common.ts";
import type { Connector, FileResult, Picture, RunResult } from "../protocol/connector.ts";
import type { ToolContent, ToolDef, ToolResult } from "../protocol/tools.ts";
import { checkInput } from "../toolkit/tools.ts";
import { checkScript, findSaves } from "../toolkit/scriptcheck.ts";
import { es3Problem } from "../toolkit/es3.ts";
import { expandHome, isFile, outputFolder, safeBase, uniquePath } from "../toolkit/files.ts";
import type { OutputRules } from "../toolkit/files.ts";
import type { Lanes } from "./lanes.ts";

export interface CallContext {
  connectors: Map<string, Connector>;
  tools: Map<string, ToolDef>;
  lanes: Lanes;
  rules: OutputRules;
  allowRiskyScripts: boolean;
}

/** The app's own file extension, for save copy / as (so a free name can be picked). */
const SAVE_EXT: Record<string, string> = { illustrator: "ai", photoshop: "psd", aftereffects: "aep", premiere: "prproj" };

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });
const report = (tool: string, data: unknown): ToolResult => text(`${tool} result: ${JSON.stringify(data, null, 1)}`);
const messageOf = (e: unknown) => String((e as Error)?.message || e || "it didn't work").replace(/[.\s]+$/, "");

function image(p: Picture): ToolContent {
  return { type: "image", data: Buffer.from(p.bytes).toString("base64"), mimeType: p.mime };
}

function pick(input: Record<string, any>, keys: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of keys) if (input[k] !== undefined && input[k] !== null) out[k] = input[k];
  return out;
}

export async function callTool(ctx: CallContext, name: string, rawInput: unknown, signal?: AbortSignal): Promise<ToolResult> {
  const def = ctx.tools.get(name);
  if (!def) return fail(`There's no tool called "${name}" here.`);
  const input = (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {}) as Record<string, any>;
  if (def.appScoped && ctx.connectors.size > 1 && (input.app == null || input.app === "")) {
    return fail(`Say which app to act in: pass "app" (${[...ctx.connectors.keys()].join(", ")}). Nothing ran.`);
  }
  const bad = checkInput(def.inputSchema, rawInput ?? {});
  if (bad) return fail(`${name} didn't run: ${bad}. Nothing changed. Fix the input and call it again.`);
  try {
    if (name === "apps") return await apps(ctx);
    if (name === "documents") return await documents(ctx, input.app ? String(input.app) : undefined, signal);
    const app = input.app ? String(input.app) : [...ctx.connectors.keys()][0]!;
    const connector = ctx.connectors.get(app);
    if (!connector) return fail(`Komposit can't work in an app called "${app}". The apps are: ${[...ctx.connectors.keys()].join(", ")}.`);
    const doc: DocRef | undefined = input.doc && typeof input.doc === "object"
      ? { app, name: String(input.doc.name), ...(input.doc.path ? { path: String(input.doc.path) } : {}) }
      : undefined;
    return await appTool(ctx, name, input, app, connector, doc, signal);
  } catch (e) {
    const hint = name === "export" || name === "save" ? " Nothing was written. Tell the person honestly, and give the manual steps in the app or offer another format." : "";
    return fail(`${name} failed: ${messageOf(e)}.${hint}`);
  }
}

// ---- apps and documents ------------------------------------------------------------------

async function apps(ctx: CallContext): Promise<ToolResult> {
  if (!ctx.connectors.size) {
    return text("Komposit's app connectors work on macOS and Windows, so there are no apps to work in on this computer.");
  }
  const list = await Promise.all([...ctx.connectors.values()].map(async (c) => {
    const m = c.manifest;
    const s: AppStatus = await c.status().catch((e): AppStatus => ({ app: m.id, label: m.label, installed: false, running: false, ready: false, reason: messageOf(e) + "." }));
    return {
      app: m.id,
      label: m.label,
      installed: s.installed,
      open: s.running,
      ready: s.ready,
      ...(s.reason ? { reason: s.reason } : {}),
      ...(s.version ? { version: s.version } : {}),
      language: m.language,
      exports: m.capabilities.export,
      saves: m.capabilities.save,
      ...(m.capabilities.singleDocument ? { note: `${m.label} keeps one project open: bring files in with place.` } : {}),
    };
  }));
  return report("apps", list);
}

async function documents(ctx: CallContext, only: string | undefined, signal?: AbortSignal): Promise<ToolResult> {
  const ids = only ? [only] : [...ctx.connectors.keys()];
  const out: Record<string, unknown>[] = [];
  for (const id of ids) {
    const c = ctx.connectors.get(id);
    if (!c) return fail(`Komposit can't work in an app called "${id}".`);
    const s = await c.status().catch(() => null);
    if (!s?.running) {
      if (only) return fail(`${c.manifest.label} isn't open. Ask the person to open it; Komposit never opens apps by itself.`);
      continue;
    }
    try {
      const docs = await ctx.lanes.run(id, () => c.documents(), signal);
      out.push({ app: id, label: c.manifest.label, documents: docs.map(({ app: _a, ...d }) => d) });
    } catch (e) {
      if (only) throw e;
      out.push({ app: id, label: c.manifest.label, error: messageOf(e) + "." });
    }
  }
  if (!out.length) return text("None of the apps is open, so there are no documents. Ask the person to open the app they want to work in.");
  return report("documents", out);
}

// ---- app tools ---------------------------------------------------------------------------

async function appTool(
  ctx: CallContext, name: string, input: Record<string, any>, app: string, connector: Connector, doc: DocRef | undefined, signal?: AbortSignal,
): Promise<ToolResult> {
  const m = connector.manifest;
  const label = m.label;
  const cap = m.capabilities;

  // Recipes are text in the connector: no app needed.
  if (name === "guide") {
    if (!connector.guide) return text(`There are no recipes for ${label} yet.`);
    const g = await connector.guide(input.topic ? String(input.topic) : undefined);
    return text(g || `There are no recipes for ${label} on that.`);
  }

  // Refusals happen before anything reaches the app.
  if (name === "edit") {
    if (!cap.run) return fail(`${label} can't run code from Komposit.`);
    const code = String(input.code || "");
    // What can't run in ExtendScript (ES3) is refused before it changes half the document.
    const es3 = m.language === "extendscript" ? es3Problem(code) : null;
    if (es3) return fail(`edit didn't run, so nothing changed: ${es3} Fix it and call edit again.`);
    if (!ctx.allowRiskyScripts) {
      const risky = checkScript(code);
      // A save to a path is already named by checkScript; findSaves adds only what it missed.
      const found = [...risky, ...findSaves(code).filter((f) => !risky.some((r) => r.snippet === f.snippet))];
      if (found.length) {
        return fail(
          `edit didn't run, so nothing changed: this script ${found.map((f) => f.what).join(", and ")} (${found.map((f) => f.snippet).join(" | ")}). ` +
          "This server only runs scripts that stay inside the document and don't save it. Do it another way: the save and export tools write files safely, " +
          "and anything outside the document is the person's to do. (The person can allow such scripts by starting the server with KOMPOSIT_ALLOW_RISKY_SCRIPTS=1.)",
        );
      }
    }
  }
  if (name === "place" || name === "open") {
    const path = String(input.path || "");
    const expanded = expandHome(path, ctx.rules.home);
    if (!isAbsolute(expanded) || !isFile(resolve(expanded))) {
      return fail(`${name} failed: there's no file at "${path}". Use an absolute path to a file that exists, such as one that export or save reported.`);
    }
    input = { ...input, path: resolve(expanded) };
  }

  // Listening to a file: heard on this computer, so the app needn't be open (Premiere Pro adds
  // the file's words when its panel answers).
  const listenOpts: { path?: string; from?: number; to?: number; pauses?: number } = name === "listen" ? pick(input, ["from", "to", "pauses"]) : {};
  if (name === "listen") {
    if (!connector.listen) return fail(`${label} can't listen from Komposit.`);
    if (input.path != null && String(input.path).trim() !== "") {
      const given = expandHome(String(input.path), ctx.rules.home);
      if (!isAbsolute(given) || !isFile(resolve(given))) return fail(`listen failed: there's no file at "${input.path}". Use an absolute path to a media file that exists.`);
      listenOpts.path = resolve(given);
      return listened(await ctx.lanes.run(app, () => connector.listen!(listenOpts, undefined, signal ? { signal } : undefined), signal));
    }
  }

  // Never start an app the person didn't open (a script sent to a closed app would).
  const status = await connector.status();
  if (!status.running) return fail(`${label} isn't open. Ask the person to open it; Komposit never opens apps by itself.`);
  if (!status.ready) return fail(status.reason || `${label} isn't ready for scripts right now.`);

  const inLane = <T>(fn: () => Promise<T>) => ctx.lanes.run(app, fn, signal);
  const call = signal ? { signal } : undefined;

  switch (name) {
    case "inspect": {
      const r = await inLane(async () => {
        const got = await connector.inspect(doc);
        const sel = connector.selection ? await connector.selection(doc).catch(() => null) : null;
        return { ...got, sel };
      });
      let t = r.text;
      if (r.sel?.summary) t += `\n\nCurrent selection:\n${r.sel.summary}`;
      return { content: [{ type: "text", text: t }, ...(r.picture ? [image(r.picture)] : [])] };
    }

    case "edit": {
      const r: RunResult = await inLane(() => connector.run(String(input.code || ""), doc, call));
      const logs = r.logs && r.logs.length ? `\nlogs: ${r.logs.join(" | ")}` : "";
      if (!r.ok) return fail(`edit failed: ${r.error}${logs}`);
      const data = r.result != null ? `\nresult: ${JSON.stringify(r.result)}` : "";
      return text(`edit applied (not saved).${data}${logs}`);
    }

    case "undo": {
      if (!cap.undo) return fail(`${label} can't undo from Komposit. Undo it in ${label} (Edit > Undo), or make a new edit that puts it back.`);
      const r = await inLane(() => connector.undo(doc, 1));
      return r.ok ? text("Undone one step.") : fail(`undo failed: ${r.error}`);
    }

    case "render": {
      if (!cap.render) return fail(`${label} can't render a preview from Komposit.`);
      // Premiere Pro also watches a stretch (every, from, to, detail: contact sheets).
      const opts = pick(input, ["frames", "video", "every", "from", "to", "detail"]);
      const r = await inLane(() => connector.render(doc, opts, call));
      const pics = r.pictures?.length ? r.pictures : r.picture ? [r.picture] : [];
      const video = r.videoPath && isFile(r.videoPath) ? `\nA preview video was rendered to ${r.videoPath} (a temporary file; export mp4 makes a full one to keep).` : "";
      return { content: [{ type: "text", text: `${r.note ? `Rendered ${r.note}.` : "Rendered."}${video}` }, ...pics.map(image)] };
    }

    case "listen": {
      return listened(await inLane(() => connector.listen!(listenOpts, doc, call)));
    }

    case "export": {
      const formats = cap.export || [];
      const f = String(input.format || "png").toLowerCase();
      if (!formats.includes(f)) return fail(`export failed: ${label} can export ${formats.join(", ") || "nothing"}, not ${f}. Offer a supported format, or the manual steps in ${label}.`);
      const dir = outputFolder(input.outputDir ? String(input.outputDir) : undefined, ctx.rules);
      const options = pick(input, ["preset", "bleedMm", "cropMarks", "artboards"]);
      const r = await inLane(async () => {
        const base = safeBase(input.name || (await docName(connector, doc)), "komposit-export");
        const planned = uniquePath(dir, base, f);
        const res = await connector.exportCopy({ ...(doc ? { doc } : {}), format: f, name: basename(planned, `.${f}`), outputDir: dir, ...(Object.keys(options).length ? { options } : {}) }, call);
        return { res, planned };
      });
      return fileReport("export", r.res, r.planned);
    }

    case "save": {
      const modes = cap.save || [];
      const mode = String(input.mode || "overwrite");
      if (!modes.includes(mode)) return fail(`save failed: ${label} supports ${modes.length ? modes.join(" and ") : "no"} saving from Komposit, not "${mode}". Offer what works, or File > Save in ${label}.`);
      if (mode === "overwrite") return fileReport("save", await inLane(() => connector.save({ ...(doc ? { doc } : {}), mode })));
      const dir = outputFolder(input.outputDir ? String(input.outputDir) : undefined, ctx.rules);
      const r = await inLane(async () => {
        const dn = await docName(connector, doc);
        const base = safeBase(input.name || (mode === "copy" ? `${dn || "document"} copy` : dn), "komposit-document");
        const ext = SAVE_EXT[app];
        const planned = ext ? uniquePath(dir, base, ext) : undefined;
        const res = await connector.save({ ...(doc ? { doc } : {}), mode, name: planned && ext ? basename(planned, `.${ext}`) : base, outputDir: dir });
        return { res, planned };
      });
      return fileReport("save", r.res, r.planned);
    }

    case "preflight": {
      if (!connector.preflight) return fail(`preflight is available in Illustrator only, not ${label}.`);
      const r = await inLane(() => connector.preflight!(doc));
      return report("preflight", { ok: true, ...r });
    }

    case "place": {
      if (!connector.place) return fail(`${label} can't bring files in from Komposit.`);
      const extra = pick(input, ["linked", "asComp", "addToComp", "addToSequence"]);
      const r = await inLane(() => connector.place!({ file: input.path, ...(doc ? { into: doc } : {}), ...extra }));
      return r.ok ? report("place", r) : fail(`place failed in ${label}: ${r.error || "it didn't work"}`);
    }

    case "open": {
      if (!connector.open) return fail(`${label} can't open files from Komposit.${cap.singleDocument ? ` ${label} keeps one project open: bring files into it with place.` : ""}`);
      const d = await inLane(() => connector.open!(input.path));
      return report("open", { ok: true, document: d });
    }

    case "new_document": {
      if (!connector.newDocument) return fail(`${label} can't make new documents from Komposit.`);
      const opts = pick(input, ["width", "height", "name"]);
      const d = await inLane(() => connector.newDocument!(opts));
      return report("new_document", { ok: true, document: d, note: "Nothing is saved yet." });
    }
  }
  return fail(`There's no tool called "${name}" here.`);
}

/** What listening heard: the numbers, and the picture of the sound. */
function listened(r: { text: string; picture?: Picture }): ToolResult {
  return { content: [{ type: "text", text: r.text }, ...(r.picture ? [image(r.picture)] : [])] };
}

/** The document's name without its extension ("Poster.ai" -> "Poster"), for new file names. */
async function docName(connector: Connector, doc: DocRef | undefined): Promise<string> {
  const bare = (n: string) => n.replace(/\.[a-z0-9]{2,5}$/i, "");
  if (doc?.name) return bare(doc.name);
  try {
    const docs = await connector.documents();
    return bare((docs.find((d) => d.active) || docs[0])?.name || "");
  } catch {
    return "";
  }
}

/** A file-writing tool's result. Never claims an overwrite: when the app wrote somewhere
 *  other than the free name picked for it, it says so. */
function fileReport(tool: "export" | "save", r: FileResult, planned?: string): ToolResult {
  if (!r.ok) return fail(`${tool} failed: ${r.error || "the app didn't write the file"}. Nothing was written. Tell the person honestly, and give the manual steps in the app or offer another format.`);
  const data: Record<string, unknown> = { ...r };
  if (planned && r.path && resolve(r.path) !== resolve(planned)) data.warnings = [...(r.warnings || []), `The app wrote ${r.path} (Komposit had picked ${planned}).`];
  return report(tool, data);
}
