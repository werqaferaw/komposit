// Adobe Illustrator, through scripting: AppleScript `do javascript` on a Mac, COM
// DoJavaScript on Windows (Adobe hasn't opened UXP to outsiders). Ported from 1.0's
// bridges/illustrator.mjs. Every script runs in quiet mode (no alerts) against the
// document it is given, and nothing here saves or repoints the person's document unless
// they asked to save.
import { existsSync } from "node:fs";
import type { DocRef } from "../../protocol/common.ts";
import type { Connector, ConnectorManifest, FileResult, RunResult } from "../../protocol/connector.ts";
import { answerOrRead, appStatus, dataOf, fileFailure, outputPath, pngPicture, runResult, watching } from "../_kit/adobe.ts";
import type { CallOptions, Kit } from "../_kit/adobe.ts";
import { guideLoader } from "../_kit/guide.ts";
import { listenToFileOnly } from "../_kit/listening.ts";
import { moveNew } from "../_kit/files.ts";
import { readAndRemove } from "../_kit/scratch.ts";
import { KitError } from "../_kit/transport.ts";
import * as S from "./scripts.ts";
import { preflightText, summarizeSelection } from "./summary.ts";

const APP = "illustrator";

export const manifest: ConnectorManifest = {
  id: APP,
  label: "Illustrator",
  maker: "Adobe",
  platforms: ["mac", "win"],
  door: "os-script",
  language: "extendscript",
  capabilities: {
    inspect: true,
    run: true,
    render: true,
    export: ["png", "jpg", "svg", "pdf"],
    save: ["copy", "overwrite", "as"],
    undo: true,
    selection: true,
    preflight: true,
    newDocument: true,
    open: true,
    place: true,
    dialog: true,
    listen: true,
  },
  heavy: ["render", "export", "inspect"],
};

const MM = 72 / 25.4;
/** app.redraw(): see run. */
const REDRAW = /\bapp\s*\.\s*redraw\s*\(/;
const stripExt = (s: string) => String(s || "document").replace(/\.[a-z0-9]{2,4}$/i, "");

export function createIllustrator(kit: Kit): Connector {
  const script = (code: string, doc: DocRef | undefined, timeoutMs: number, call?: CallOptions) =>
    kit.runner.stdout(APP, code, { guard: S.guard(doc), timeoutMs: call?.timeoutMs ?? timeoutMs, signal: call?.signal });

  async function docName(doc?: DocRef): Promise<string> {
    if (doc?.name) return stripExt(doc.name);
    return stripExt(dataOf<string>(await script(S.DOC_NAME, doc, 30000)));
  }

  async function render(doc?: DocRef, _opts?: { frames?: number; video?: boolean }, call?: CallOptions) {
    const out = kit.scratch.name("il-render", "png");
    const d = dataOf<{ artboard: string }>(await watching(kit, APP, call, () => script(S.render(out, kit.renderMaxPx), doc, 120000, call)));
    if (!existsSync(out)) throw new KitError("Illustrator reported no error but drew no picture.", "NO_OUTPUT");
    return { picture: pngPicture(readAndRemove(out)), note: `the active artboard "${d.artboard}"` };
  }

  const connector: Connector = {
    manifest,

    status: () => appStatus(kit, APP),

    async documents() {
      const d = dataOf<{ documents: { name: string; path: string | null; active: boolean }[] }>(await script(S.DOCUMENTS, undefined, 30000));
      return d.documents.map((x) => ({ app: APP, name: x.name, ...(x.path ? { path: x.path } : {}), active: !!x.active }));
    },

    async inspect(doc?: DocRef) {
      const d = dataOf<any>(await script(S.INSPECT, doc, 60000));
      if (d.noDocument) return { text: "No document open in Illustrator." };
      const picture = await render(doc).then((r) => r.picture, () => undefined);
      return { text: JSON.stringify(d, null, 2), ...(picture ? { picture } : {}) };
    },

    async selection(doc?: DocRef) {
      const d = dataOf<any>(await script(S.SELECTION, doc, 8000));
      return { summary: summarizeSelection(d), data: d };
    },

    // Run a surgical ExtendScript edit against the document. Never saves. app.redraw() is
    // refused: in Illustrator each one ends an undo step (and one report says it can drop the
    // person's undo history), so an edit with it lands as several steps the person has to undo
    // one by one. Illustrator has no undo grouping, so an edit is one step only without it.
    async run(code: string, doc?: DocRef, call?: CallOptions): Promise<RunResult> {
      if (REDRAW.test(code)) {
        return { ok: false, error: "app.redraw() isn't allowed in a Komposit edit: in Illustrator each call ends an undo step, so this edit would land in the person's undo history as several steps. Nothing ran. Leave it out: Komposit's renders and exports see the changes without it.", logs: [] };
      }
      const env = await watching(kit, APP, call, () => script(code, doc, 180000, call));
      return runResult(env);
    },

    render,

    // Export a COPY to a new file. Never overwrites, never touches the source.
    async exportCopy({ doc, format, name, outputDir, options = {} }, call?: CallOptions): Promise<FileResult> {
      const f = String(format || "png").toLowerCase().replace("jpeg", "jpg");
      if (!manifest.capabilities.export.includes(f)) {
        return { ok: false, error: `Illustrator can export ${manifest.capabilities.export.join(", ")}; not "${format}".` };
      }
      try {
        const out = await outputPath(kit, { outputDir, name, ext: f }, () => docName(doc));
        if (f === "pdf") {
          const preset = String(options.preset || "[PDF/X-4:2008]");
          const bleedMm = options.bleedMm;
          const bleed = bleedMm == null || bleedMm === "" ? 3 : Math.max(0, Math.min(25, Number(bleedMm) || 0));
          const marks = options.cropMarks == null ? true : !!options.cropMarks;
          const artboards = options.artboards ? String(options.artboards) : undefined;
          const tmp = kit.scratch.name("il-copy", "ai");
          const code = S.exportPdf({ out, tmp, preset, bleedPt: +(bleed * MM).toFixed(3), cropMarks: marks, artboards });
          const d = dataOf<any>(await watching(kit, APP, call, () => script(code, doc, 300000, call)));
          if (!d.written) throw new KitError("Illustrator reported no error but wrote no PDF.", "NO_OUTPUT");
          const warnings: string[] = [];
          if (d.rgb) warnings.push("RGB document. PDF/X-4 keeps RGB, but many printers want CMYK; ask yours.");
          if (!d.unchanged) warnings.push("The open document's name, path or saved state changed during export; check it.");
          const parts = [preset.replace(/[\[\]]/g, ""), bleed ? `${bleed} mm bleed` : "no bleed", marks ? "crop marks" : "no crop marks"];
          return {
            ok: true,
            path: out,
            note: `PDF (${parts.join(", ")}), ${artboards ? `artboards ${artboards}` : `all ${d.artboards} artboard${d.artboards === 1 ? "" : "s"}`}, made ${d.made}.`,
            warnings,
            sourceUnchanged: !!d.unchanged,
          };
        }
        // Written under a plain scratch name, then put in place (moveNew says why).
        const tmp = kit.scratch.name("il-export", f);
        const d = dataOf<any>(await watching(kit, APP, call, () => script(S.exportImage(f as "png" | "jpg" | "svg", tmp), doc, 180000, call)));
        if (!existsSync(tmp)) throw new KitError("Illustrator reported no error but wrote no file.", "NO_OUTPUT");
        const path = moveNew(tmp, out);
        const what = {
          png: "PNG of the active artboard, for screens and previews, not print",
          jpg: "JPG of the active artboard, for screens, not print",
          svg: "SVG of the document, for the web",
        }[f];
        return { ok: true, path, note: `${what} (artboard "${d.artboard}").`, warnings: [], sourceUnchanged: true };
      } catch (e) {
        return fileFailure(e);
      }
    },

    // Save, only when the person asked. "overwrite" saves the file itself (Cmd+S / Ctrl+S);
    // "as" makes the open document a new file; "copy" writes a new .ai and leaves the open
    // document as it is.
    async save({ doc, mode = "copy", name, outputDir }): Promise<FileResult> {
      try {
        if (mode === "overwrite") {
          const d = dataOf<any>(await script(S.SAVE_OVERWRITE, doc, 300000));
          if (d.neverSaved) return { ok: false, error: `"${d.name}" has never been saved, so there is no original to overwrite. Save a copy instead.` };
          return { ok: true, path: d.path, note: d.hadChanges ? `Saved "${d.name}" over the original file.` : `"${d.name}" had no unsaved changes; saved anyway.`, warnings: [] };
        }
        if (mode === "as") {
          const out = await outputPath(kit, { outputDir, name, ext: "ai" }, () => docName(doc));
          const d = dataOf<any>(await script(S.saveAs(out), doc, 300000));
          return { ok: true, path: d.path, note: `Saved as "${d.name}". The open document is now that file, so later saves (overwrite) go there.`, warnings: [] };
        }
        if (mode !== "copy") return { ok: false, error: `Illustrator saves as copy, overwrite or as; not "${mode}".` };
        const out = await outputPath(kit, { outputDir, name, ext: "ai" }, async () => `${await docName(doc)} copy`);
        const d = dataOf<any>(await script(S.saveCopy(out, kit.scratch.name("il-copy", "ai")), doc, 300000));
        if (!d.written) throw new KitError("Illustrator reported no error but wrote no file.", "NO_OUTPUT");
        return {
          ok: true,
          path: out,
          note: `Saved a copy as an Illustrator file, made ${d.made}. The open document is unchanged and still has its own unsaved changes, if any.`,
          warnings: d.unchanged ? [] : ["The open document's name, path or saved state changed; check it."],
          sourceUnchanged: !!d.unchanged,
        };
      } catch (e) {
        return fileFailure(e);
      }
    },

    async undo(doc?: DocRef, steps = 1): Promise<RunResult> {
      const n = Math.max(1, Math.min(50, Math.round(Number(steps) || 1)));
      const env = await script(S.undo(n), doc, 60000);
      return runResult(env);
    },

    async preflight(doc?: DocRef) {
      const d = dataOf<any>(await script(S.PREFLIGHT, doc, 180000));
      return { text: preflightText(d), issues: d.warnings || [] };
    },

    // "Show in": the document in front, then the app.
    async show(doc?: DocRef) {
      dataOf(await script(S.SHOW, doc, 30000));
      await kit.transport.activateApp(APP);
    },

    async newDocument({ width = 1000, height = 1000 } = {}) {
      await kit.transport.activateApp(APP);
      const d = dataOf<{ name: string }>(await script(S.newDocument(Number(width) || 1000, Number(height) || 1000), undefined, 60000));
      return { app: APP, name: d.name };
    },

    async open(path: string) {
      if (!existsSync(path)) throw new KitError(`There's no file at ${path}.`, "NO_FILE");
      const d = dataOf<{ opened: string; path: string }>(await script(S.open(path), undefined, 180000));
      return { app: APP, name: d.opened, path: d.path || path };
    },

    // Bring a file from elsewhere into the document (linked unless said otherwise).
    async place({ file, into, linked }): Promise<FileResult> {
      if (!existsSync(file)) return { ok: false, error: `There's no file at ${file}.` };
      try {
        const d = dataOf<any>(await script(S.place(file, linked !== false), into, 120000));
        return { ok: true, path: file, note: `Placed ${d.placed} into "${d.into}" (${d.linked ? "linked" : "embedded"}, ${d.size.join("×")} pt), centred on the active artboard.`, warnings: [] };
      } catch (e) {
        return fileFailure(e);
      }
    },

    guide: guideLoader(new URL("./guide.md", import.meta.url)),

    // Illustrator has no timeline: listening hears a file by its path, on this computer, and never
    // reaches Illustrator.
    async listen(o) {
      const r = await listenToFileOnly(kit.ear, "Illustrator", o);
      return { text: r.text, picture: r.picture, heard: r.heard };
    },

    dialog: (action, button) => answerOrRead(kit, APP, action, button),
  };
  return connector;
}
