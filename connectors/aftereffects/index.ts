// Adobe After Effects, through scripting. After Effects has NO return channel for scripts
// (AppleScript `DoScript` on a Mac, `AfterFX.exe -r` on Windows), so every call WRITES its
// JSON result to a scratch file that the runner reads back. Ported from 1.0's
// bridges/aftereffects.mjs. New in v2: every script runs with dialogs suppressed.
//
// On a Mac, scripts go to the After Effects that's open, whatever its year (mac.ts:
// aeTarget); AE_APP overrides the app name.
import { existsSync, statSync } from "node:fs";
import type { DocRef } from "../../protocol/common.ts";
import type { Connector, ConnectorManifest, FileResult, Picture, RunResult } from "../../protocol/connector.ts";
import { answerOrRead, appStatus, dataOf, fileFailure, outputPath, pngPicture, runResult, watching } from "../_kit/adobe.ts";
import type { CallOptions, Kit } from "../_kit/adobe.ts";
import { guideLoader } from "../_kit/guide.ts";
import { readAndRemove, rmQuiet } from "../_kit/scratch.ts";
import { KitError } from "../_kit/transport.ts";
import * as S from "./scripts.ts";
import { summarizeSelection } from "./summary.ts";

const APP = "aftereffects";
/** Longest a step waits for a dialog that's up before it can send its script. */
const AE_DIALOG_WAIT_MS = 5 * 60 * 1000;

/** A file that's there and not empty (After Effects makes a frame's file before drawing it). */
const hasBytes = (p: string): boolean => {
  try {
    return statSync(p).size > 0;
  } catch {
    return false;
  }
};

export const manifest: ConnectorManifest = {
  id: APP,
  label: "After Effects",
  maker: "Adobe",
  platforms: ["mac", "win"],
  door: "os-script",
  language: "extendscript",
  capabilities: {
    inspect: true,
    run: true,
    render: true,
    export: ["png", "mp4"],
    save: ["overwrite"],
    undo: true,
    selection: true,
    newDocument: true,
    place: true,
    dialog: true,
    singleDocument: true,
  },
  heavy: ["render", "export", "inspect"],
  partLabel: "comp",
};

/** What render gives back: the middle frame as `picture`, all of them as `pictures`. */
export interface AeRender {
  picture?: Picture;
  pictures?: Picture[];
  videoPath?: string;
  note?: string;
}

export function createAfterEffects(kit: Kit): Connector {
  const script = (code: string, doc: DocRef | undefined, timeoutMs: number, call?: CallOptions) =>
    kit.runner.file(APP, code, {
      guard: S.guard(doc, call?.label),
      timeoutMs: call?.timeoutMs ?? timeoutMs,
      signal: call?.signal,
      // A step (it hears about dialogs) waits for the person's dialog to close; reads don't.
      ...(call?.onWait ? { onWait: call.onWait, dialogWaitMs: Math.min(call.timeoutMs ?? timeoutMs, AE_DIALOG_WAIT_MS) } : {}),
    });

  async function render(doc?: DocRef, opts: { frames?: number; video?: boolean } = {}, call?: CallOptions): Promise<AeRender> {
    // A video comes with 4 frames across the work area unless frames were asked for: the AI
    // checks the motion in the same call (about 50 ms a frame) while the person gets the video.
    const n = Math.max(1, Math.min(8, Math.round(Number(opts.frames) || (opts.video ? 4 : 1))));
    const paths = Array.from({ length: n }, (_, i) => kit.scratch.name(`ae-render-${i}`, "png"));
    const videoPath = opts.video ? kit.scratch.name("ae-preview", "mp4") : null;
    let d: any;
    try {
      d = dataOf<any>(await watching(kit, APP, call, () => script(S.render(paths, videoPath), doc, opts.video ? 600000 : 180000, call)));
      // An empty file is no frame either (After Effects makes the file before it draws it).
      if (paths.some((p) => !hasBytes(p))) throw new KitError("After Effects reported no error but drew no frame.", "NO_OUTPUT");
    } catch (e) {
      for (const p of paths) rmQuiet(p);
      throw e;
    }
    const pictures = paths.map((p) => pngPicture(readAndRemove(p)));
    const note = n === 1 ? `the current frame of "${d.comp}"` : `${n} frames of "${d.comp}" at ${d.times.join("s, ")}s`;
    return {
      picture: pictures[Math.floor((pictures.length - 1) / 2)],
      pictures,
      ...(videoPath && d.video ? { videoPath } : {}),
      note: videoPath && d.video ? `${note}; a preview video of ${d.video.seconds}s from ${d.video.start}s (half resolution)` : note,
    };
  }

  return {
    manifest,

    status: () => appStatus(kit, APP),

    // After Effects keeps one project open: its "document".
    async documents() {
      const d = dataOf<{ documents: { name: string; path: string | null; active: boolean; comps: string[]; part?: { id: string; name: string } | null }[] }>(await script(S.DOCUMENTS, undefined, 30000));
      return d.documents.map((x) => ({ app: APP, name: x.name, ...(x.path ? { path: x.path } : {}), active: true, comps: x.comps, ...(x.part ? { part: { id: String(x.part.id), name: x.part.name } } : {}) }));
    },

    async inspect(doc?: DocRef) {
      const d = dataOf<any>(await script(S.INSPECT, doc, 60000));
      if (d.noDocument) return { text: "No project open in After Effects." };
      const picture = d.comp ? await render(doc).then((r) => r.picture, () => undefined) : undefined;
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
      const f = String(format || "png").toLowerCase();
      if (f !== "png" && f !== "mp4") return { ok: false, error: `After Effects can export png (one frame) and mp4 (the work area); not "${format}".` };
      let out: string | undefined;
      try {
        out = await outputPath(kit, { outputDir, name, ext: f, fallback: f === "mp4" ? "komposit-video" : "komposit-frame" });
        const to = out;
        const d = dataOf<any>(await watching(kit, APP, call, () => script(S.exportCopy(f, to), doc, f === "mp4" ? 1800000 : 120000, call)));
        if (!hasBytes(to)) throw new KitError("After Effects reported no error but wrote no file.", "NO_OUTPUT");
        const note =
          f === "mp4"
            ? `H.264 MP4 of "${d.comp}", ${d.w}×${d.h}, the work area (${d.seconds}s from ${d.start}s). Rendered through the render queue; the person's own queued items were paused and put back.`
            : `PNG of one frame of "${d.comp}" at ${d.time}s. A still, not a video.`;
        return { ok: true, path: to, note, warnings: [], sourceUnchanged: true };
      } catch (e) {
        // The name was a free one, so an empty file there is this export's own.
        if (out && existsSync(out) && !hasBytes(out)) rmQuiet(out);
        return fileFailure(e);
      }
    },

    async save({ doc, mode = "overwrite" }): Promise<FileResult> {
      if (mode === "as") return { ok: false, error: "After Effects can't save the project as a new file from Komposit; use File > Save As." };
      if (mode !== "overwrite") return { ok: false, error: "After Effects can't save a copy from Komposit; use File > Save a Copy." };
      try {
        const d = dataOf<any>(await script(S.SAVE_OVERWRITE, doc, 300000));
        if (d.neverSaved) return { ok: false, error: "This project has never been saved, so there is no file to overwrite. Use File > Save As in After Effects." };
        return { ok: true, path: d.path, note: `Saved the project "${d.name}".`, warnings: [] };
      } catch (e) {
        return fileFailure(e);
      }
    },

    async undo(doc?: DocRef, steps = 1): Promise<RunResult> {
      const n = Math.max(1, Math.min(50, Math.round(Number(steps) || 1)));
      const env = await script(S.undo(n), doc, 60000);
      return runResult(env);
    },

    // "Show in": After Effects has one project open, so it's the app coming forward.
    async show() {
      await kit.transport.activateApp(APP);
    },

    // A new comp in the open project. Returns the project, with the comp's name beside it.
    async newDocument({ width = 1920, height = 1080, name = "Komposit Comp", seconds = 10 } = {}) {
      await kit.transport.activateApp(APP);
      const length = Math.min(3600, Math.max(1, Number(seconds) || 10));
      const d = dataOf<{ comp: string; name: string; path: string | null }>(await script(S.newComp(name || "Komposit Comp", Number(width) || 1920, Number(height) || 1080, length, 30), undefined, 60000));
      return { app: APP, name: d.name, ...(d.path ? { path: d.path } : {}), comp: d.comp };
    },

    // Bring a file into the project (and the open comp). After Effects has no `open`: it
    // keeps one project, and opening another would close the person's.
    async place({ file, into }): Promise<FileResult> {
      if (!existsSync(file)) return { ok: false, error: `There's no file at ${file}.` };
      try {
        const d = dataOf<any>(await script(S.place(file), into, 120000));
        const where = d.addedTo ? ` and added it to the comp "${d.addedTo}" as the layer "${d.layer}"` : "";
        return { ok: true, path: file, note: `Imported ${d.placed} into the project as ${d.kind === "composition" ? "a composition" : "footage"} "${d.item}"${where}.`, warnings: [] };
      } catch (e) {
        return fileFailure(e);
      }
    },

    guide: guideLoader(new URL("./guide.md", import.meta.url)),

    dialog: (action, button) => answerOrRead(kit, APP, action, button),
  };
}
