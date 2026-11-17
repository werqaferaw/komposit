// Adobe Premiere Pro, through Komposit's own panel inside it (door "in-app-plugin").
// Premiere takes no scripts from outside (no AppleScript `do javascript`, no COM), so a
// hidden CEP extension (panel/, installed by install.ts) runs the ExtendScript Komposit sends
// it over 127.0.0.1 (door.ts). Ported from 1.0's bridges/premiere.mjs, premiere-panel.mjs and
// handoff.mjs.
//
// Premiere's scripts act on its ACTIVE project, and once in 1.0 that was the person's real
// project while a test ran. So here:
//   - a call that changes a project (edit, undo, save, place, a preview video) must name the
//     project (a DocRef), and runs only when that project is the active one: the check runs
//     inside the same script, so nothing can switch projects in between;
//   - a call that names a project it can't find, or one that isn't active, changes nothing;
//   - an edit can't save, open, close or switch projects, or reach into other open projects;
//   - nothing saves the project except save, which only runs when the person asked to save;
//   - exports, renders and saved copies never write over a file.
// Reads (documents, inspect, selection, renders, exports) work on the active project.
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { AppStatus, DocRef } from "../../protocol/common.ts";
import type { Connector, ConnectorManifest, FileResult, Picture, RunResult } from "../../protocol/connector.ts";
import { dataOf, fileFailure, outputPath, pngPicture, runResult, watching } from "../_kit/adobe.ts";
import type { CallOptions, Kit } from "../_kit/adobe.ts";
import { wrap } from "../_kit/envelope.ts";
import type { Envelope } from "../_kit/envelope.ts";
import { moveNew } from "../_kit/files.ts";
import { guideLoader } from "../_kit/guide.ts";
import { readAndRemove, rmQuiet } from "../_kit/scratch.ts";
import { KitError } from "../_kit/transport.ts";
import { createPanelDoor } from "./door.ts";
import { cepExtensionsDir, panelAddressFile, premierePanelState } from "./install.ts";
import type { DebugModeSwitch } from "./install.ts";
import { refuseScript } from "./scriptcheck.ts";
import * as S from "./scripts.ts";
import { contactSheets, smallerPng } from "./sheets.ts";
import { summarizeSelection } from "./summary.ts";
import { K_LIB } from "./toolkit.ts";

const APP = "premiere";
const LABEL = "Premiere Pro";

export const manifest: ConnectorManifest = {
  id: APP,
  label: LABEL,
  maker: "Adobe",
  platforms: ["mac", "win"],
  door: "in-app-plugin",
  language: "extendscript",
  capabilities: {
    inspect: true,
    run: true,
    render: true,
    export: ["png", "mp4"],
    save: ["overwrite", "copy", "as"],
    undo: true,
    selection: true,
    place: true,
    open: true,
  },
  heavy: ["render", "export", "inspect"],
  partLabel: "sequence",
};

export interface PremiereOptions {
  /** Where the panel writes its address. Default: premiere-panel.json under "dev.werq.komposit"
   *  in the person's application data (install.ts panelAddressFile). */
  panelFile?: string;
  /** The CEP extensions folder, to tell why the panel isn't answering. Default: the person's own. */
  extensionsDir?: string;
  /** Reads CEP's PlayerDebugMode, for the same. Default: the system's setting. */
  debugMode?: Pick<DebugModeSwitch, "read">;
  /** The home folder the default places are under. Default: os.homedir(). */
  home?: string;
}

/** Render options Premiere reads (the toolbox passes them through). */
export interface PremiereRenderOptions {
  frames?: number;
  video?: boolean;
  /** Watch a stretch: a frame every this many seconds (contact sheets). */
  every?: number;
  from?: number;
  to?: number;
  /** Larger frames on the contact sheets. */
  detail?: boolean;
}

/** Most frames one watch call looks at. */
export const MAX_WATCH = 96;

/** The app bundle a running program is in: ".../Adobe Premiere Pro 2026.app/Contents/MacOS/Adobe
 *  Premiere Pro 2026" -> ".../Adobe Premiere Pro 2026.app". Null when it isn't in one. */
export function appBundleOf(comm: string): string | null {
  const m = /^(\/.+?\.app)\/Contents\/MacOS\//.exec(String(comm || "").trim());
  return m ? m[1]! : null;
}

/** How long after the last frame is in before Premiere's Events pop-up setting is put back:
 *  each frame's "Exported frame" event comes just after its file, and must find it still off. */
const EVENTS_SETTLE_MS = 500;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The plain refusal for a change that doesn't name its project. Nothing reaches Premiere. */
export function needsProject(what: string): string {
  return `${what} in Premiere Pro needs the project named: pass doc with its name and path, as the open-files list (or documents) gives them, so nothing lands in another project. Nothing ran.`;
}

// Premiere writes an exported frame a moment after the call returns, and may add ".png"
// itself: wait for a complete file. Null when none came.
async function waitForFile(base: string, timeoutMs: number): Promise<string | null> {
  const cands = [base, base + ".png"];
  const t0 = Date.now();
  let last = -1;
  while (Date.now() - t0 < timeoutMs) {
    for (const c of cands) {
      if (!existsSync(c)) continue;
      let size = -1;
      try { size = statSync(c).size; } catch { /* still being written */ }
      if (size > 0 && size === last) return c;
      last = size;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

export function createPremiere(kit: Kit, o: PremiereOptions = {}): Connector {
  const places = { platform: kit.platform, ...(o.home ? { home: o.home } : {}) };
  const door = createPanelDoor({ file: o.panelFile ?? panelAddressFile(places), incidents: kit.incidents });
  const extensionsDir = o.extensionsDir ?? cepExtensionsDir(places);
  const device = kit.platform === "win" ? "PC" : "Mac";

  // Why the panel can't be reached, in one plain sentence.
  async function unreachable(): Promise<string> {
    if (!(await kit.transport.isAppRunning(APP).catch(() => true))) return `${LABEL} isn't open. Open it, then try again.`;
    const st = await premierePanelState({ platform: kit.platform, extensionsDir, ...(o.debugMode ? { debugMode: o.debugMode } : {}) }).catch(() => null);
    if (!st || !st.installed) return `Komposit's panel isn't installed in ${LABEL} yet, so Komposit can't reach it.`;
    if (!st.current) return `Komposit's panel in ${LABEL} is out of date: install it again, then quit and reopen ${LABEL}.`;
    if (st.debugMode === false) return `${LABEL} won't load Komposit's panel until unsigned panels are allowed: install the panel again, then quit and reopen ${LABEL}.`;
    const pid = await kit.transport.appPid(APP).catch(() => null);
    const up = pid ? await kit.transport.processUptime(pid).catch(() => 0) : 0;
    if (up > 0 && up < 60) return `${LABEL} is still starting; Komposit's panel loads a few seconds after it opens.`;
    return `${LABEL} hasn't loaded Komposit's panel: quit and reopen ${LABEL} once.`;
  }

  // One script in Premiere: quiet, and (with a DocRef) only in that project, when it's the
  // active one. `prefix` goes in front of the code on its first line (the K toolkit).
  async function send(code: string, doc: DocRef | undefined, timeoutMs: number, call?: CallOptions, prefix = ""): Promise<Envelope> {
    const source = wrap(prefix + code, { viaEval: true, guard: S.guard(doc) });
    const env = await door.run(source, { timeoutMs: call?.timeoutMs ?? timeoutMs, signal: call?.signal, script: code, unreachable });
    if (env.ok) return env;
    if (env.error?.startsWith(S.REFUSED)) {
      // The guard's own refusal: a plain sentence, no line number.
      const error = env.error.slice(S.REFUSED.length).replace(/\s*\(line \d+\)\s*$/, "");
      kit.incidents.record({ app: APP, kind: "blocked", code: "NOT_TARGET", message: error, script: code });
      return { ...env, error, code: "NOT_TARGET" };
    }
    if (!env.code) kit.incidents.record({ app: APP, kind: "script-error", message: env.error, script: code });
    return env;
  }

  const refused = (error: string): Envelope => ({ ok: false, error, code: "NEEDS_PROJECT", logs: [], data: null });

  // Premiere's Events pop-up ("Exported frame ..." at the bottom right, once per frame) stays
  // off while Komposit's own frames come in: the frame scripts turn the person's setting off
  // for the session and say what it was (scripts.ts, HUSH); this puts it back once the frames
  // are in, after EVENTS_SETTLE_MS for their events to pass. Calls can overlap, so the setting
  // from before the first is kept, and put back when the last is done. If putting it back
  // fails, the next frames try again (and the change was never saved, so Premiere starts
  // with the person's own setting next time either way).
  const events = { busy: 0, was: null as string | null };
  async function hushed<T>(fn: (quiet: (was: string | null | undefined) => void) => Promise<T>): Promise<T> {
    events.busy++;
    try {
      return await fn((was) => { if (typeof was === "string" && events.was === null) events.was = was; });
    } finally {
      events.busy--;
      if (events.busy === 0 && events.was !== null) {
        await new Promise((r) => setTimeout(r, EVENTS_SETTLE_MS));
        const was = events.was;
        if (events.busy === 0 && was !== null) {
          const env = await send(S.restoreEvents(was), undefined, 15000).catch(() => null);
          if (env?.ok && events.was === was) events.was = null;
        }
      }
    }
  }

  // Frames of the active sequence as pictures for the AI (shrunk to renderMaxPx).
  async function grab(times: (number | null)[], doc: DocRef | undefined, call?: CallOptions): Promise<{ pictures: Picture[]; times: number[]; sequence: string }> {
    const outs = times.map(() => kit.scratch.name("pr-frame", "png"));
    try {
      return await hushed(async (quiet) => {
        const d = dataOf<{ times: number[]; sequence: string; quiet?: string | null }>(await watching(kit, APP, call, () => send(S.frames(times, outs), doc, 120000, call)));
        quiet(d.quiet);
        const pictures: Picture[] = [];
        for (const out of outs) {
          const f = await waitForFile(out, 15000);
          if (!f) throw new KitError(`${LABEL} didn't write the frame. Is the Program Monitor showing the sequence?`, "NO_OUTPUT");
          const small = smallerPng(readAndRemove(f), kit.renderMaxPx);
          pictures.push(pngPicture(small.bytes));
        }
        return { pictures, times: d.times, sequence: d.sequence };
      });
    } finally {
      for (const out of outs) { rmQuiet(out); rmQuiet(out + ".png"); }
    }
  }

  async function sequenceInfo(doc: DocRef | undefined): Promise<any> {
    return dataOf<any>(await send(S.SEQ_INFO, doc, 30000));
  }

  // A short low-bitrate MP4 (up to 10 s around the playhead) for the person to watch. It sets
  // the sequence's in and out points for a moment, so it needs the project named.
  async function preview(doc: DocRef, call?: CallOptions): Promise<string> {
    const out = kit.scratch.name("pr-preview", "mp4");
    dataOf(await watching(kit, APP, call, () => send(S.encode(out, true), doc, 180000, call)));
    if (!existsSync(out)) throw new KitError(`${LABEL} didn't write the preview video.`, "NO_OUTPUT");
    return out;
  }

  // Watching a stretch: a frame every `every` seconds from `from` to `to` (or `frames` of them
  // spread evenly), as contact sheets with each frame's time under it, plus which clip every
  // frame comes from. Up to MAX_WATCH frames a call; a longer stretch says where to carry on.
  async function watchStretch(doc: DocRef | undefined, o: PremiereRenderOptions, call?: CallOptions) {
    const q = await sequenceInfo(doc);
    const frame = 1 / (q.fps || 30);
    const [ia, ib] = q.inOut || [0, q.duration];
    const a = Math.max(0, o.from == null ? ia : Number(o.from));
    const b = Math.min(q.duration, o.to == null ? ib : Number(o.to));
    if (!(b - a > frame / 2)) throw new KitError(`Nothing to watch between ${a} and ${b} s (the sequence is ${q.duration} s long).`, "NOTHING_TO_WATCH");
    const step = Number(o.every) > 0 ? Math.max(frame, Number(o.every)) : (b - a) / Math.max(1, Math.min(MAX_WATCH, Math.round(Number(o.frames) || 24)));
    const times: number[] = [];
    for (let t = a; t < b - frame / 2 && times.length < MAX_WATCH; t += step) times.push(Math.round(t * 1000) / 1000);
    const more = a + times.length * step < b - frame / 2 ? r2(a + times.length * step) : null;
    const outs = times.map(() => kit.scratch.name("pr-watch", "png"));
    try {
      const { res, files } = await hushed(async (quiet) => {
        const res = dataOf<{ from: ({ v: number; c: number; name: string; start: number; end: number; src: number } | null)[]; quiet?: string | null }>(
          await watching(kit, APP, call, () => send(S.watch(times, outs), doc, 300000, call)),
        );
        quiet(res.quiet);
        return { res, files: await Promise.all(outs.map((p) => waitForFile(p, 30000))) };
      });
      // A line over a frame marks the first frame of a new clip, so the cuts show on the sheet.
      let last = "";
      const list: { png: Uint8Array; label: string; mark: boolean }[] = [];
      times.forEach((t, i) => {
        const h = res.from[i], key = h ? `${h.v}:${h.c}` : "-";
        const f = files[i];
        if (f) list.push({ png: readAndRemove(f), label: String(r2(t)), mark: key !== last && i > 0 });
        last = key;
      });
      let made: ReturnType<typeof contactSheets>;
      try {
        made = contactSheets(list, { detail: !!o.detail });
      } catch (e) {
        throw new KitError(`${list.length ? "Komposit couldn't read Premiere Pro's frames to make contact sheets" : `${LABEL} didn't write the frames`} (${(e as Error).message}). Look with frames 2-8 instead.`, "NO_SHEETS");
      }
      // Which clip each frame is from, a line per clip.
      const groups: { key: string; h: (typeof res.from)[number]; times: number[]; srcFrom: number | null; srcTo: number | null }[] = [];
      times.forEach((t, i) => {
        const h = res.from[i], key = h ? `${h.v}:${h.c}` : "-", g = groups[groups.length - 1];
        if (g && g.key === key) { g.times.push(t); if (h) g.srcTo = h.src; }
        else groups.push({ key, h, times: [t], srcFrom: h ? h.src : null, srcTo: h ? h.src : null });
      });
      const lines = groups.map((g) =>
        (g.h ? `V${g.h.v + 1} clip ${g.h.c} "${g.h.name}" (on the timeline ${g.h.start}–${g.h.end} s; these frames are its source at ${g.srcFrom}${g.srcTo !== g.srcFrom ? `–${g.srcTo}` : ""} s): ` : "nothing on screen: ") +
        g.times.map(r2).join(", "),
      );
      const stepSaid = Math.round(step * 1000) / 1000;
      const head = `${made.count} frames, one every ${stepSaid} s from ${times[0]} to ${times[times.length - 1]} s of "${q.name}", on ${made.sheets.length} contact sheet${made.sheets.length === 1 ? "" : "s"} (read left to right, top to bottom; the number under a frame is its time in seconds; a yellow line over a frame is the first frame of a new clip)`;
      const note = `${head}.\nWhere each frame comes from:\n${lines.join("\n")}${more != null ? `\nThe stretch goes on: watch again from ${more} to see the rest.` : ""}`;
      const pictures = made.sheets.map((s) => pngPicture(s));
      return { picture: pictures[0], pictures, note };
    } finally {
      for (const out of outs) { rmQuiet(out); rmQuiet(out + ".png"); }
    }
  }

  // One frame at the playhead, `frames` (2-8) spread across the sequence (or its in/out
  // range), or (every/from/to, or more than 8 frames) a stretch to watch on contact sheets.
  // `video` also makes a short MP4 for the person.
  async function render(doc?: DocRef, opts: PremiereRenderOptions = {}, call?: CallOptions) {
    let out: { picture?: Picture; pictures?: Picture[]; videoPath?: string; note?: string };
    if (opts.every != null || opts.from != null || opts.to != null || Number(opts.frames) > 8) {
      out = await watchStretch(doc, opts, call);
    } else {
      const n = Math.max(1, Math.min(8, Math.round(Number(opts.frames) || 1)));
      let times: (number | null)[] = [null];
      if (n > 1) {
        const q = await sequenceInfo(doc);
        const [a, b] = q.inOut || [0, q.duration];
        times = Array.from({ length: n }, (_, i) => r2(a + ((b - a) * (i + 0.5)) / n));
      }
      const g = await grab(times, doc, call);
      out = {
        picture: g.pictures[Math.floor((g.pictures.length - 1) / 2)],
        ...(n > 1 ? { pictures: g.pictures } : {}),
        note: n > 1 ? `${n} frames of "${g.sequence}" at ${g.times.join(", ")} s` : `the frame at the playhead (${g.times[0]} s) of "${g.sequence}"`,
      };
    }
    if (opts.video) {
      if (!doc) out.note = `${out.note}. No preview video: making one sets the sequence's in and out points for a moment, so it needs the project named (pass doc)`;
      else {
        out.videoPath = await preview(doc, call);
        out.note = `${out.note}; a preview video of up to 10 s around the playhead (low bitrate)`;
      }
    }
    return out;
  }

  async function sequenceName(doc?: DocRef): Promise<string> {
    return String(dataOf<string>(await send(S.ACTIVE_SEQUENCE_NAME, doc, 30000)) || "sequence");
  }

  const projectName = (doc?: DocRef) => String(doc?.name || "project").replace(/\.prproj$/i, "");

  const connector: Connector = {
    manifest,

    // Running, and the panel answering. Nothing reaches Premiere's scripting.
    async status(): Promise<AppStatus> {
      const t = kit.transport;
      const [installedPath, running] = await Promise.all([t.installedPath(APP).catch(() => null), t.isAppRunning(APP).catch(() => false)]);
      const installed = !!installedPath || running;
      const base: AppStatus = { app: APP, label: LABEL, installed, running, ready: false };
      if (!running) return { ...base, reason: installed ? `${LABEL} isn't open.` : `${LABEL} isn't installed on this ${device}.` };
      const p = await door.ping();
      if (p.ok) return { ...base, ready: true, ...(p.host?.appVersion ? { version: String(p.host.appVersion) } : {}) };
      return { ...base, reason: await unreachable() };
    },

    // The open projects, with their sequences; the active one is where scripts go.
    async documents() {
      const d = dataOf<{ documents: { name: string; path: string | null; active: boolean; sequences?: string[]; part?: { id: string; name: string } | null }[] }>(await send(S.DOCUMENTS, undefined, 30000));
      return d.documents.map((x) => ({ app: APP, name: x.name, ...(x.path ? { path: x.path } : {}), active: !!x.active, sequences: x.sequences || [], ...(x.part ? { part: { id: String(x.part.id), name: x.part.name } } : {}) }));
    },

    async inspect(doc?: DocRef) {
      const d = dataOf<any>(await send(S.INSPECT, doc, 60000));
      if (d.noDocument) return { text: `No project open in ${LABEL}.` };
      const picture = d.sequence ? await render(doc).then((r) => r.picture, () => undefined) : undefined;
      return { text: JSON.stringify(d, null, 2), ...(picture ? { picture } : {}) };
    },

    async selection(doc?: DocRef) {
      const d = dataOf<any>(await send(S.SELECTION, doc, 8000));
      return { summary: summarizeSelection(d), data: d };
    },

    // Edits get the K toolkit in front of their code, on the same line.
    async run(code: string, doc?: DocRef, call?: CallOptions): Promise<RunResult> {
      const no = refuseScript(code);
      if (no) {
        kit.incidents.record({ app: APP, kind: "blocked", code: "SCRIPT_REFUSED", message: no, script: code });
        return { ok: false, error: no, logs: [] };
      }
      if (!doc) return runResult(refused(needsProject("An edit")));
      const env = await watching(kit, APP, call, () => send(code, doc, 180000, call, K_LIB + " "));
      return runResult(env);
    },

    render,

    // A new file; the project is left as it was.
    async exportCopy({ doc, format, name, outputDir }, call?: CallOptions): Promise<FileResult> {
      const f = String(format || "png").toLowerCase();
      if (f !== "png" && f !== "mp4") return { ok: false, error: `${LABEL} can export png (the frame at the playhead) and mp4 (the sequence); not "${format}".` };
      try {
        const out = await outputPath(kit, { outputDir, name, ext: f, fallback: f === "mp4" ? "komposit-video" : "komposit-frame" }, () => sequenceName(doc));
        if (f === "mp4") {
          const d = dataOf<any>(await watching(kit, APP, call, () => send(S.encode(out, false), doc, 1800000, call)));
          if (!existsSync(out)) return { ok: false, error: `${LABEL} didn't write the video (${d.result}).` };
          return { ok: true, path: out, note: `H.264 MP4 of the ${d.range} of "${d.sequence}", ${d.w}×${d.h}, matching the sequence's settings (preset ${d.preset}).`, warnings: [], sourceUnchanged: true };
        }
        const scratch = kit.scratch.name("pr-export", "png");
        try {
          const { d, file } = await hushed(async (quiet) => {
            const d = dataOf<{ times: number[]; w: number; h: number; sequence: string; quiet?: string | null }>(await watching(kit, APP, call, () => send(S.frames([null], [scratch]), doc, 120000, call)));
            quiet(d.quiet);
            return { d, file: await waitForFile(scratch, 15000) };
          });
          if (!file) return { ok: false, error: `${LABEL} didn't write the frame. Is the Program Monitor showing the sequence?` };
          const path = moveNew(file, out);
          return { ok: true, path, note: `PNG of the frame at the playhead (${d.times[0]} s) of "${d.sequence}", ${d.w}×${d.h}. A still, not a video.`, warnings: [], sourceUnchanged: true };
        } finally {
          rmQuiet(scratch);
          rmQuiet(scratch + ".png");
        }
      } catch (e) {
        return fileFailure(e);
      }
    },

    // Only when the person asked to save, and only the project the call names, when it's the
    // active one. overwrite: the project's own file. as: a new file the open project becomes.
    // copy: the active sequence and its media as a new project; the open project stays as it is.
    async save({ doc, mode = "overwrite", name, outputDir }): Promise<FileResult> {
      if (!doc) return { ok: false, error: needsProject("Saving") };
      try {
        if (mode === "overwrite") {
          const d = dataOf<{ path: string; name: string }>(await send(S.SAVE_OVERWRITE, doc, 300000));
          return { ok: true, path: d.path, note: `Saved the project "${d.name}".`, warnings: [] };
        }
        if (mode !== "as" && mode !== "copy") return { ok: false, error: `${LABEL} saves overwrite, copy or as; not "${mode}".` };
        const out = await outputPath(kit, { outputDir, name, ext: "prproj", fallback: "komposit-project" }, async () => (mode === "copy" ? `${projectName(doc)} copy` : projectName(doc)));
        if (mode === "as") {
          const d = dataOf<{ path: string; name: string; was: string; switched: boolean }>(await send(S.saveAs(out), doc, 300000));
          return {
            ok: true,
            path: d.path,
            note:
              `Saved the project as "${d.name}". The open project is now that file, so later saves go there (the file from before keeps what it last saved); name it as doc from now on.` +
              (d.switched ? "" : ` ${LABEL} hadn't switched to it yet when the save came back: check documents before the next change.`),
            warnings: [],
          };
        }
        const d = dataOf<{ sequence: string; project: string }>(await send(S.saveCopy(out), doc, 300000));
        if (!(await waitForFile(out, 20000))) return { ok: false, error: `${LABEL} didn't write the copy.` };
        return {
          ok: true,
          path: out,
          note: `A new project with the sequence "${d.sequence}" and the media it uses (other sequences aren't in it). The open project "${d.project}" is unchanged and still the one being worked in.`,
          warnings: [],
          sourceUnchanged: true,
        };
      } catch (e) {
        return fileFailure(e);
      }
    },

    async undo(doc?: DocRef, steps = 1): Promise<RunResult> {
      if (!doc) return runResult(refused(needsProject("Undo")));
      const n = Math.max(1, Math.min(50, Math.round(Number(steps) || 1)));
      return runResult(await send(S.undo(n), doc, 60000));
    },

    // Bring a file into the project (a "Komposit" bin) and onto the active sequence at the
    // playhead (addToSequence: false to only import).
    async place({ file, into, addToSequence }: { file: string; into?: DocRef; linked?: boolean; addToSequence?: boolean }): Promise<FileResult> {
      if (!existsSync(file)) return { ok: false, error: `There's no file at ${file}.` };
      if (!into) return { ok: false, error: needsProject("Placing a file") };
      try {
        const d = dataOf<any>(await send(S.place(file, addToSequence !== false), into, 120000));
        const where = d.track ? ` and put it on ${d.track} of "${d.addedTo}" at ${d.at} s` : "";
        return { ok: true, path: file, note: `Imported ${d.placed} into the project "${d.project}" (bin "${d.bin}")${where}.`, warnings: [] };
      } catch (e) {
        return fileFailure(e);
      }
    },

    // Open a project; it becomes the active one. One that's already open is left as it is: if
    // it isn't the active one, the person brings it forward (Komposit never switches projects).
    async open(path: string): Promise<DocRef> {
      if (!/\.prproj$/i.test(path)) throw new KitError(`${LABEL} opens projects (.prproj); bring footage, audio or stills into the open project with place instead.`, "NOT_A_PROJECT");
      const d = dataOf<{ name: string; path: string; already: boolean; active: boolean }>(await send(S.open(path), undefined, 180000));
      if (d.already && !d.active) {
        throw new KitError(`${d.name} is already open in ${LABEL}, but it isn't the active project. Ask the person to click into it in ${LABEL}; then name it as doc.`, "NOT_ACTIVE");
      }
      // (Not active yet right after opening: the next change that names it says so plainly.)
      return { app: APP, name: d.name, path: d.path };
    },

    // "Show in": Premiere Pro comes forward as it is (its one open project). Its app name
    // carries a year and AppleScript has no name for it here, so on a Mac the running app's own
    // bundle is opened again (macOS brings a running app forward; no permission needed).
    async show() {
      if (kit.platform === "win") { await kit.transport.activateApp(APP); return; }
      const pid = await kit.transport.appPid(APP).catch(() => null);
      if (!pid) throw new KitError(`${LABEL} isn't open.`, "NOT_RUNNING");
      const comm = await new Promise<string>((resolve) => execFile("ps", ["-o", "comm=", "-p", String(pid)], { timeout: 4000, encoding: "utf8" }, (_e, out) => resolve(String(out || ""))));
      const bundle = appBundleOf(comm);
      if (!bundle) throw new KitError(`Komposit couldn't bring ${LABEL} forward. Switch to it yourself.`, "NOT_FOUND");
      await new Promise<void>((resolve) => execFile("open", [bundle], { timeout: 10000 }, () => resolve()));
    },

    guide: guideLoader(new URL("./guide.md", import.meta.url)),
  };
  return connector;
}
