// Stand-ins for the tests, so Premiere Pro's connector is tested end to end without
// Premiere: a small made-up Premiere (the ExtendScript DOM and QE DOM the scripts use, over a
// temp folder) and a made-up CEP host that runs the REAL panel (panel/bridge.js) in a Node vm:
// its HTTP server, token and address file are the ones that ship, and every script it gets
// runs, as sent, against the made-up Premiere. Never talks to a real app.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { encodePng } from "./sheets.ts";

const nodeRequire = createRequire(import.meta.url);
export const TPS = 254016000000;
export const BRIDGE_JS = fileURLToPath(new URL("./panel/bridge.js", import.meta.url));

type Obj = Record<string, any>;

/** An ExtendScript-like collection: index access and a count property. */
function list<T>(arr: T[], count: string): T[] {
  Object.defineProperty(arr, count, { get() { return this.length; } });
  return arr;
}

// ---------- Time, File, Folder ----------

function TimeClass() {
  function Time(this: Obj) { this._t = 0; }
  Object.defineProperty(Time.prototype, "seconds", { get() { return this._t / TPS; }, set(v: number) { this._t = Math.round(Number(v) * TPS); } });
  Object.defineProperty(Time.prototype, "ticks", { get() { return String(this._t); }, set(v: string) { this._t = Number(v); } });
  Time.prototype.getFormatted = function (this: Obj) { return "tc:" + this.ticks; };
  return Time as unknown as { new (): Obj };
}
export const Time = TimeClass();
export const time = (sec: number) => { const t = new Time(); t.seconds = sec; return t; };
const secondsOfTc = (tc: string) => Number(String(tc).replace(/^tc:/, "")) / TPS;

// ExtendScript's File and Folder: callable with or without `new`, enough for the scripts.
class FileImpl {
  fsName: string;
  name: string;
  encoding = "UTF-8";
  lineFeed = "Unix";
  private buf = "";
  private mode = "";
  constructor(p: string) {
    this.fsName = String(p);
    this.name = encodeURI(basename(this.fsName));
  }
  get exists() { return existsSync(this.fsName) && statSync(this.fsName).isFile(); }
  get parent() { return new FolderImpl(dirname(this.fsName)); }
  open(mode: string) { this.mode = mode; this.buf = ""; return true; }
  write(s: string) { this.buf += s; return true; }
  close() { if (this.mode === "w") writeFileSync(this.fsName, this.buf); return true; }
  remove() { rmSync(this.fsName, { force: true }); return true; }
}
class FolderImpl {
  fsName: string;
  name: string;
  constructor(p: string) {
    this.fsName = String(p);
    this.name = encodeURI(basename(this.fsName));
  }
  get exists() { return existsSync(this.fsName) && statSync(this.fsName).isDirectory(); }
  getFiles(mask?: string) {
    const re = mask ? new RegExp("^" + mask.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i") : null;
    return readdirSync(this.fsName).filter((n) => !re || re.test(n)).map((n) => new FileImpl(join(this.fsName, n)));
  }
}
// A plain function that returns an object works both as File(p) and as new File(p).
function fileClasses() {
  return { File: function (p: string) { return new FileImpl(p); } as any, Folder: function (p: string) { return new FolderImpl(p); } as any };
}

// ---------- the made-up Premiere ----------

export interface StandInOptions {
  /** A temp folder for the projects, media and Premiere's own files. */
  dir: string;
  /** Frame size of the sequence. */
  w?: number;
  h?: number;
  version?: string;
  os?: string;
}

/** Premiere Pro with two projects open: "Show.prproj" (active; sequence "Podcast", 20 s at
 *  25 fps, three cameras and two mics) and "Client.prproj" (the person's other work). */
export function standInPremiere(o: StandInOptions) {
  const { File, Folder } = fileClasses();
  const W = o.w ?? 320, H = o.h ?? 180, FPS = 25;
  const log: string[] = [];
  let ids = 1;
  const projDir = join(o.dir, "projects");
  const mediaDir = join(o.dir, "media");
  const appDir = join(o.dir, "Adobe Premiere Pro 2026.app");
  for (const d of [projDir, mediaDir, join(appDir, "Contents", "MediaIO", "systempresets", "4E49434B_48323634")]) mkdirSync(d, { recursive: true });
  for (const n of ["01 - Match Source - Low bitrate.epr", "01 - Match Source - Medium bitrate.epr", "01 - Match Source - High bitrate.epr"]) {
    writeFileSync(join(appDir, "Contents", "MediaIO", "systempresets", "4E49434B_48323634", n), "<preset/>");
  }

  const item = (name: string, path = "", type = 1): Obj => ({ name, type, nodeId: "i" + ids++, getMediaPath: () => path, isSequence: () => false });
  const bin = (name: string): Obj => {
    const b: Obj = { name, type: 2, nodeId: "b" + ids++, children: list([] as Obj[], "numItems"), isSequence: () => false };
    b.createBin = (n: string) => { const c = bin(n); b.children.push(c); log.push(`createBin:${n}`); return c; };
    return b;
  };
  const clip = (name: string, start: number, end: number, path = "", selected = false): Obj => ({
    name, nodeId: "n" + ids++, start: time(start), end: time(end), inPoint: time(0), outPoint: time(end - start), disabled: false,
    components: list([{ displayName: "Opacity", matchName: "AE.ADBE Opacity" }, { displayName: "Motion", matchName: "AE.ADBE Motion" }], "numItems"),
    projectItem: item(name, path), getSpeed: () => 1, isSpeedReversed: () => false, isSelected: () => selected,
  });
  const track = (name: string, clips: Obj[]): Obj => {
    const t: Obj = { name, clips: list(clips, "numItems"), transitions: list([] as Obj[], "numItems"), isMuted: () => false, isLocked: () => false };
    t.overwriteClip = (it: Obj, sec: number) => { t.clips.push(clip(it.name, sec, sec + 5)); log.push(`overwriteClip:${t.name}:${it.name}@${sec}`); return true; };
    return t;
  };
  const sequence = (name: string, id: string): Obj => {
    let inT = -400000 * TPS, outT = -400000 * TPS, player = 5;
    const s: Obj = {
      name, sequenceID: id,
      videoTracks: list([track("Video 1", [clip("wide.mp4", 0, 20)]), track("Video 2", [clip("host cam.mp4", 0, 8, "", true), clip("guest cam.mp4", 8, 20)]), track("Video 3", [])], "numTracks"),
      audioTracks: list([track("Audio 1", [clip("host mic.wav", 0, 20)]), track("Audio 2", [clip("guest mic.wav", 0, 20)])], "numTracks"),
      markers: { getFirstMarker: () => ({ start: time(2), end: time(2), name: "intro", comments: "" }), getNextMarker: () => null },
      getSettings: () => ({ videoFrameWidth: W, videoFrameHeight: H, videoFrameRate: { ticks: String(TPS / FPS), seconds: 1 / FPS }, videoDisplayFormat: 101 }),
      getPlayerPosition: () => time(player),
      getInPointAsTime: () => { const t = new Time(); t.ticks = String(inT); return t; },
      getOutPointAsTime: () => { const t = new Time(); t.ticks = String(outT); return t; },
      setInPoint: (v: number | string) => { inT = typeof v === "string" ? Number(v) : Math.round(v * TPS); log.push(`setInPoint:${typeof v === "string" ? "ticks" : v}`); },
      setOutPoint: (v: number | string) => { outT = typeof v === "string" ? Number(v) : Math.round(v * TPS); log.push(`setOutPoint:${typeof v === "string" ? "ticks" : v}`); },
      getSelection: () => [s.videoTracks[1].clips[0]],
      get end() { let e = 0; for (const T of [s.videoTracks, s.audioTracks]) for (const t of T) for (const c of t.clips) e = Math.max(e, c.end.seconds); return String(Math.round(e * TPS)); },
      exportAsMediaDirect: (out: string, preset: string, which: number) => {
        log.push(`exportAsMediaDirect:${basename(preset)}:${which}:in=${Math.round(inT / TPS * 100) / 100}:out=${Math.round(outT / TPS * 100) / 100}`);
        writeFileSync(out, "fake mp4");
        return true;
      },
      exportAsProject: (path: string) => { log.push(`exportAsProject:${s.name}`); writeFileSync(path, "fake prproj (sequence)"); return 0; },
      clone: () => true,
      _player: (sec: number) => { player = sec; },
      _inOut: () => [inT, outT],
    };
    return s;
  };
  const project = (name: string, docId: string, seqName: string | null): Obj => {
    const path = join(projDir, name);
    writeFileSync(path, "fake prproj");
    const seq = seqName ? sequence(seqName, `seq-${docId}`) : null;
    const p: Obj = {
      name, path, documentID: docId, rootItem: bin("root"),
      sequences: list(seq ? [seq] : [], "numSequences"),
      activeSequence: seq,
      save: () => { log.push(`save:${p.name}`); writeFileSync(p.path, `saved ${Date.now()}`); return 0; },
      saveAs: (to: string) => {
        // Like Premiere: the project goes to the new file, opens from there, and the one from
        // before closes.
        log.push(`saveAs:${p.name}->${basename(to)}`);
        writeFileSync(to, "fake prproj (saved as)");
        p.path = to;
        p.name = basename(to);
        return 0;
      },
      importFiles: (paths: string[], _ui: boolean, into: Obj) => { for (const f of paths) into.children.push(item(basename(f), f)); log.push(`importFiles:${paths.map((f) => basename(f)).join(",")}:${into.name}`); return true; },
      openSequence: (id: string) => { log.push(`openSequence:${id}`); return true; },
    };
    p.rootItem.children.push(item("wide.mp4", join(mediaDir, "wide.mp4")), item("host mic.wav", join(mediaDir, "host mic.wav")));
    return p;
  };

  const show = project("Show.prproj", "doc-1", "Podcast");
  const client = project("Client.prproj", "doc-2", "Cut 3");
  const projects = list([show, client], "numProjects");
  let undos = 0;
  // Premiere's preferences as scripts see them (app.properties), with the Events pop-up on, as
  // it comes. Like Premiere, each exported frame's "Exported frame" event comes just after its
  // file, and pops up (counted in `popups`) when the setting is on at that moment.
  const prefs: Record<string, string> = { "fe.status.showErrorOverlay": "true" };
  const prefLog: string[] = [];
  let popups = 0;
  const properties: Obj = {
    doesPropertyExist: (k: string) => k in prefs,
    isPropertyReadOnly: () => false,
    getProperty: (k: string) => prefs[k] ?? "",
    setProperty: (k: string, v: unknown, persistent: boolean, create: boolean) => {
      if (!(k in prefs) && !create) return null;
      prefs[k] = String(v);
      prefLog.push(`${k}=${v}${persistent ? "" : " (this session)"}`);
      return null;
    },
  };
  const qs = (s: () => Obj | null) => ({
    exportFramePNG: (tc: string, out: string) => {
      const sec = secondsOfTc(tc);
      log.push(`exportFramePNG:${Math.round(sec * 1000) / 1000}`);
      // A picture whose color tells the time, written a moment later, as Premiere does.
      const px = new Uint8Array(W * H * 3);
      const v = Math.max(0, Math.min(255, Math.round(sec * 12)));
      for (let i = 0; i < px.length; i += 3) { px[i] = v; px[i + 1] = 255 - v; px[i + 2] = 40; }
      setTimeout(() => { writeFileSync(out, encodePng(px, W, H)); setTimeout(() => { if (prefs["fe.status.showErrorOverlay"] === "true") popups++; }, 20); }, 30);
      return true;
    },
    _seq: s,
  });
  const app: Obj = {
    version: o.version ?? "26.5.3",
    path: appDir,
    projects,
    get project() { return app._active; },
    _active: show,
    encoder: { ENCODE_ENTIRE: 0, ENCODE_IN_TO_OUT: 1, ENCODE_WORKAREA: 2 },
    properties,
    enableQE: () => true,
    getCurrentProjectViewSelection: () => null,
    openDocument: (path: string) => {
      const p = project(basename(path), "doc-" + (projects.length + 1), null);
      p.path = path;
      projects.push(p);
      app._active = p;
      log.push(`openDocument:${basename(path)}`);
      return true;
    },
  };
  const qe = { project: { getActiveSequence: () => qs(() => app.project?.activeSequence ?? null), undo: () => { undos++; log.push("qe.undo"); } } };
  const globals = () => ({ app, qe, Time, File, Folder, ProjectItemType: { CLIP: 1, BIN: 2, ROOT: 3, FILE: 4 }, Sequence: { CAPTION_FORMAT_SUBTITLE: 0 }, $: { os: o.os ?? "Macintosh OS 14.6.1", sleep() {} } });
  return { app, qe, show, client, globals, log, undos: () => undos, prefs, prefLog, popups: () => popups, dirs: { projDir, mediaDir, appDir } };
}
export type StandInPremiere = ReturnType<typeof standInPremiere>;

// ---------- the made-up CEP host, running the real panel ----------

export interface StandInPanelOptions {
  /** The person's home folder, as the panel's Node sees it (os.homedir()). */
  home: string;
  /** Runs a script in the made-up Premiere; what Premiere's evalScript would hand back. */
  evalScript: (script: string) => string | null;
  platform?: "darwin" | "win32";
  env?: Record<string, string>;
  /** The panel's process id as it writes it (default: this process, which is alive). */
  pid?: number;
}

export interface StandInPanel {
  /** Where the panel wrote its address. */
  file: string;
  port: number;
  token: string;
  /** Every script it ran. */
  scripts: string[];
  /** Premiere closes the extension (the panel forgets its address and stops listening). */
  stop(): Promise<void>;
}

/** Starts panel/bridge.js the way CEP does (Node in the page, a host for evalScript). */
export async function startStandInPanel(o: StandInPanelOptions): Promise<StandInPanel> {
  const scripts: string[] = [];
  const unload: (() => void)[] = [];
  const servers: any[] = [];
  const http = nodeRequire("http");
  // Keep the server the panel makes, so stop() can wait for it to close.
  const httpSpy = { ...http, createServer: (...a: any[]) => { const s = http.createServer(...a); servers.push(s); return s; } };
  const sandbox: Obj = {
    require: (m: string) => (m === "os" ? { ...os, homedir: () => o.home } : m === "http" ? httpSpy : nodeRequire(m)),
    process: { platform: o.platform ?? "darwin", env: o.env ?? {}, pid: o.pid ?? process.pid },
    Buffer, Promise, JSON, Date, setTimeout, clearTimeout, console,
    window: {
      __adobe_cep__: {
        getHostEnvironment: () => JSON.stringify({ appName: "PPRO", appVersion: "26.5.3" }),
        evalScript: (script: string, cb: (r: string) => void) => {
          scripts.push(script);
          const r = o.evalScript(script);
          if (r !== null) setTimeout(() => cb(r), 0);
        },
      },
      addEventListener: (type: string, fn: () => void) => { if (type === "unload") unload.push(fn); },
    },
  };
  vm.runInNewContext(readFileSync(BRIDGE_JS, "utf8"), sandbox, { filename: "bridge.js" });
  const folder = o.platform === "win32" ? join(o.env?.APPDATA || join(o.home, "AppData", "Roaming"), "dev.werq.komposit") : join(o.home, "Library", "Application Support", "dev.werq.komposit");
  const file = join(folder, "premiere-panel.json");
  const t0 = Date.now();
  while (!existsSync(file) && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
  const info = JSON.parse(readFileSync(file, "utf8"));
  return {
    file,
    port: info.port,
    token: info.token,
    scripts,
    async stop() {
      for (const fn of unload) fn();
      await Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r(null)); setTimeout(() => r(null), 500); })));
    },
  };
}

/** The made-up Premiere behind a made-up CEP host: what evalScript does with a script. */
export function runIn(premiere: StandInPremiere): (script: string) => string {
  return (script) => {
    try {
      return String(vm.runInNewContext(script, premiere.globals(), { timeout: 5000 }));
    } catch {
      return "EvalScript error.";
    }
  };
}
