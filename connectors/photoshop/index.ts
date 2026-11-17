// Adobe Photoshop, through scripting: `do javascript` by bundle id on a Mac
// (version-independent), COM DoJavaScript on Windows. Ported from 1.0's
// bridges/photoshop.mjs. Every script runs with displayDialogs = NO against the document
// it is given (by Photoshop's own document id where it has one).
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { DocRef } from "../../protocol/common.ts";
import { UNDO_LABEL, type Connector, type ConnectorManifest, type FileResult, type RunResult } from "../../protocol/connector.ts";
import { answerOrRead, appStatus, dataOf, fileFailure, outputPath, pngPicture, runResult, watching } from "../_kit/adobe.ts";
import type { CallOptions, Kit } from "../_kit/adobe.ts";
import { guideLoader } from "../_kit/guide.ts";
import { listenToFileOnly } from "../_kit/listening.ts";
import { moveNew } from "../_kit/files.ts";
import { readAndRemove } from "../_kit/scratch.ts";
import { KitError } from "../_kit/transport.ts";
import * as S from "./scripts.ts";
import { summarizeSelection } from "./summary.ts";

const APP = "photoshop";

export const manifest: ConnectorManifest = {
  id: APP,
  label: "Photoshop",
  maker: "Adobe",
  platforms: ["mac", "win"],
  door: "os-script",
  language: "extendscript",
  capabilities: {
    inspect: true,
    run: true,
    render: true,
    export: ["png", "jpg"],
    save: ["copy", "overwrite", "as"],
    undo: true,
    selection: true,
    newDocument: true,
    open: true,
    place: true,
    dialog: true,
    undoOwn: true,
    listen: true,
  },
  heavy: ["render", "export", "inspect"],
};

const stripExt = (s: string) => String(s || "document").replace(/\.[a-z0-9]{2,4}$/i, "");

export function createPhotoshop(kit: Kit): Connector {
  const script = (code: string, doc: DocRef | undefined, timeoutMs: number, call?: CallOptions) =>
    kit.runner.stdout(APP, code, { guard: S.guard(doc, call?.label), timeoutMs: call?.timeoutMs ?? timeoutMs, signal: call?.signal });

  async function docName(doc?: DocRef): Promise<string> {
    if (doc?.name) return stripExt(doc.name);
    return stripExt(dataOf<string>(await script(S.DOC_NAME, doc, 30000)));
  }

  async function render(doc?: DocRef, _opts?: { frames?: number; video?: boolean }, call?: CallOptions) {
    const out = kit.scratch.name("ps-render", "png");
    dataOf(await watching(kit, APP, call, () => script(S.render(out), doc, 120000, call)));
    if (!existsSync(out)) throw new KitError("Photoshop reported no error but drew no picture.", "NO_OUTPUT");
    return { picture: pngPicture(readAndRemove(out)), note: "the flattened canvas" };
  }

  const ref = (d: { name: string; path?: string | null; id?: string | null }): DocRef => ({
    app: APP,
    name: d.name,
    ...(d.path ? { path: d.path } : {}),
    ...(d.id ? { id: d.id } : {}),
  });

  return {
    manifest,

    status: () => appStatus(kit, APP),

    async documents() {
      const d = dataOf<{ documents: { name: string; path: string | null; id: string | null; active: boolean }[] }>(await script(S.DOCUMENTS, undefined, 30000));
      return d.documents.map((x) => ({ ...ref(x), active: !!x.active }));
    },

    async inspect(doc?: DocRef) {
      const d = dataOf<any>(await script(S.INSPECT, doc, 60000));
      if (d.noDocument) return { text: "No document open in Photoshop." };
      const picture = await render(doc).then((r) => r.picture, () => undefined);
      return { text: JSON.stringify(d, null, 2), ...(picture ? { picture } : {}) };
    },

    async selection(doc?: DocRef) {
      const d = dataOf<any>(await script(S.SELECTION, doc, 8000));
      return { summary: summarizeSelection(d), data: d };
    },

    async run(code: string, doc?: DocRef, call?: CallOptions): Promise<RunResult> {
      const env = await watching(kit, APP, call, () => script(code, doc, 180000, call));
      return runResult(env);
    },

    render,

    async exportCopy({ doc, format, name, outputDir }, call?: CallOptions): Promise<FileResult> {
      const f = String(format || "png").toLowerCase().replace("jpeg", "jpg");
      if (!manifest.capabilities.export.includes(f)) return { ok: false, error: `Photoshop can export png and jpg; not "${format}".` };
      try {
        const out = await outputPath(kit, { outputDir, name, ext: f }, () => docName(doc));
        // Written under a plain scratch name, then put in place: Save for Web turns spaces
        // into hyphens and overwrites what has that name (moveNew).
        const tmp = kit.scratch.name("ps-export", f);
        dataOf(await watching(kit, APP, call, () => script(S.exportImage(f as "png" | "jpg", tmp), doc, 180000, call)));
        if (!existsSync(tmp)) throw new KitError("Photoshop reported no error but wrote no file.", "NO_OUTPUT");
        const path = moveNew(tmp, out);
        const what = f === "jpg" ? "JPG, flattened, for screens" : "PNG, flattened, for screens";
        return { ok: true, path, note: `${what}. Not a print file.`, warnings: [], sourceUnchanged: true };
      } catch (e) {
        return fileFailure(e);
      }
    },

    // Save, only when the person asked: "overwrite" saves the file itself (Cmd+S /
    // Ctrl+S); "as" makes the open document the new .psd; "copy" writes a layered .psd
    // and leaves the open document as it is.
    async save({ doc, mode = "copy", name, outputDir }): Promise<FileResult> {
      try {
        if (mode === "overwrite") {
          const d = dataOf<any>(await script(S.SAVE_OVERWRITE, doc, 300000));
          if (d.neverSaved) return { ok: false, error: `"${d.name}" has never been saved, so there is no original to overwrite. Save a copy instead.` };
          return { ok: true, path: d.path, note: `Saved "${d.name}" over the original file.`, warnings: [] };
        }
        if (mode === "as") {
          const out = await outputPath(kit, { outputDir, name, ext: "psd" }, () => docName(doc));
          const d = dataOf<any>(await script(S.saveLayered(out, false), doc, 300000));
          return { ok: true, path: d.path, note: `Saved as "${d.name}". The open document is now that file, so later saves (overwrite) go there.`, warnings: [] };
        }
        if (mode !== "copy") return { ok: false, error: `Photoshop saves as copy, overwrite or as; not "${mode}".` };
        const out = await outputPath(kit, { outputDir, name, ext: "psd" }, async () => `${await docName(doc)} copy`);
        const d = dataOf<any>(await script(S.saveLayered(out, true), doc, 300000));
        if (!d.written) throw new KitError("Photoshop reported no error but wrote no file.", "NO_OUTPUT");
        return { ok: true, path: out, note: "Saved a layered .psd copy. The open document is unchanged.", warnings: [], sourceUnchanged: true };
      } catch (e) {
        return fileFailure(e);
      }
    },

    async undo(doc?: DocRef, steps = 1): Promise<RunResult> {
      const n = Math.max(1, Math.min(50, Math.round(Number(steps) || 1)));
      const env = await script(S.undo(n), doc, 60000);
      // Komposit's own refusal (the latest state is the person's): a plain sentence, no hint.
      if (!env.ok && env.error?.startsWith(S.UNDO_REFUSED)) return { ok: false, error: env.error.slice(S.UNDO_REFUSED.length).replace(/\s*\(line \d+\)\s*$/, ""), logs: [] };
      return runResult(env);
    },

    // "Show in": the document in front, then the app.
    async show(doc?: DocRef) {
      dataOf(await script(S.SHOW, doc, 30000));
      await kit.transport.activateApp(APP);
    },

    async newDocument({ width = 1080, height = 1080, name = "Untitled" } = {}) {
      await kit.transport.activateApp(APP);
      const d = dataOf<{ name: string; id: string | null }>(await script(S.newDocument(Number(width) || 1080, Number(height) || 1080, name || "Untitled"), undefined, 60000));
      return ref(d);
    },

    async open(path: string) {
      if (!existsSync(path)) throw new KitError(`There's no file at ${path}.`, "NO_FILE");
      const d = dataOf<{ opened: string; path: string; id: string | null }>(await script(S.open(path), undefined, 180000));
      return ref({ name: d.opened, path: d.path || path, id: d.id });
    },

    // Bring a file from elsewhere into the document as a smart object (embedded unless linked).
    async place({ file, into, linked }): Promise<FileResult> {
      if (!existsSync(file)) return { ok: false, error: `There's no file at ${file}.` };
      try {
        const d = dataOf<any>(await script(S.place(file, linked === true), into, 120000, { label: `${UNDO_LABEL}place ${basename(file)}` }));
        return {
          ok: true,
          path: file,
          note: `Placed ${d.placed} into "${d.into}" as the layer "${d.layer}"${d.smartObject ? ", a smart object" : ""} (${d.linked ? "linked" : "embedded"}), centred.`,
          warnings: [],
        };
      } catch (e) {
        return fileFailure(e);
      }
    },

    guide: guideLoader(new URL("./guide.md", import.meta.url)),

    // Photoshop has no timeline: listening hears a file by its path, on this computer, and never
    // reaches Photoshop.
    async listen(o) {
      const r = await listenToFileOnly(kit.ear, "Photoshop", o);
      return { text: r.text, picture: r.picture, heard: r.heard };
    },

    dialog: (action, button) => answerOrRead(kit, APP, action, button),
  };
}
