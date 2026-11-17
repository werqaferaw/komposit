// Windows: how the scripting connectors reach Illustrator, Photoshop and After Effects on
// a PC. The macOS counterpart is mac.ts; both build the same ScriptTransport.
//
//   Illustrator, Photoshop  COM automation: "Illustrator.Application" /
//                           "Photoshop.Application" DoJavaScript(code) returns the
//                           script's last expression (as `do javascript` does on the Mac).
//   After Effects           no COM. `AfterFX.exe -r <file.jsx>` hands the script to the
//                           running After Effects; the wrapped script writes its result to
//                           a file, which we wait for.
//
// System calls go through komposit-win.exe, a small .NET Framework program: COM calls
// (with a message filter that retries while the app is busy), process and window lists
// (for the dialog notice), opening files. Every Windows 10/11 PC has .NET Framework 4.8,
// so a checkout without a built helper compiles it once with the framework's own csc.exe.
//
// Pure helpers (command lines, parsers) are exported so they can be unit-tested on any
// OS; they use path.win32 so the results are Windows paths everywhere.
//
// Ported as-is from 1.0, where it ran on five real PCs; it can't run on a Mac.
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join as hjoin, win32 as wpath } from "node:path";
import { homedir } from "node:os";
import { aeScriptWritesPref } from "./aeprefs.ts";
import { createScratch, rmQuiet } from "./scratch.ts";
import type { Scratch } from "./scratch.ts";
import { KitError, labelOf } from "./transport.ts";
import type { AutomationState, DialogBox, RunJsxOptions, ScriptTransport, WindowMap } from "./transport.ts";

const HOME = homedir();

function envDir(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

interface RunOut {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], timeout = 8000): Promise<RunOut> {
  return new Promise((res) => {
    execFile(cmd, args, { timeout, encoding: "utf8", windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout, stderr) =>
      res({ ok: !err, stdout: stdout || "", stderr: stderr || "" }),
    );
  });
}

export const PROGID: Record<string, string> = { illustrator: "Illustrator.Application", photoshop: "Photoshop.Application" };
// Program file names, as tasklist and the process list show them.
export const EXE: Record<string, string> = { illustrator: "Illustrator.exe", photoshop: "Photoshop.exe", aftereffects: "AfterFX.exe", premiere: "Adobe Premiere Pro.exe" };
const exeBase = (app: string) => (EXE[app] || "").replace(/\.exe$/i, "");

const TIMEOUT_TEXT = (label: string) =>
  `${label} didn't answer in time. If it's showing a dialog, close it. The step may still finish inside the app, so check before retrying.`;

/** The app's data folder, %APPDATA%\dev.werq.komposit (shell/config.ts DATA_FOLDER), never an
 *  older Komposit's %APPDATA%\Komposit: a helper built on demand goes in its bin folder. */
export function defaultDataDir(): string {
  return wpath.join(envDir("APPDATA", wpath.join(HOME, "AppData", "Roaming")), "dev.werq.komposit");
}

// `reg query` output -> { valueName: data } (REG_SZ and REG_EXPAND_SZ).
export function parseRegQuery(out: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of String(out).split(/\r?\n/)) {
    const m = /^\s{2,}(.+?)\s{2,}(REG_\w+)\s{2,}(.*)$/.exec(line);
    if (m) values[m[1]] = m[3].trim();
  }
  return values;
}

// ---------- the helper (komposit-win.exe) ----------

// Where a built helper can be: set by the tray app, next to the bundled node, the
// caller's own list, or compiled on demand into the data folder.
export function helperCandidates({ env = process.env, execPath = process.execPath, extra = [] as string[], dataDir = defaultDataDir() } = {}): string[] {
  return [env.KOMPOSIT_WIN_HELPER, wpath.join(wpath.dirname(execPath), "komposit-win.exe"), ...extra, wpath.join(dataDir, "bin", "komposit-win.exe")].filter(
    (p): p is string => !!p,
  );
}

// The csc.exe command line that builds the helper from its one source file.
export function cscArgs(src: string, out: string): string[] {
  return ["/nologo", "/optimize+", "/target:exe", "/platform:anycpu", `/out:${out}`, "/r:System.Drawing.dll", src];
}

interface HelperResult {
  ok: boolean;
  code: string | null;
  json: any;
  stdout: string;
  stderr: string;
}

// The COM failure codes the helper reports -> the error the connectors and the incident
// log understand. The wording mirrors the Mac's where the cause is the same.
export function comError(app: string, res: { code?: string | null; json?: { error?: string } | null; stderr?: string }): KitError {
  const label = labelOf(app);
  const msg = String(res.json?.error || res.stderr || "").trim();
  switch (res.code) {
    case "NOT_INSTALLED":
      return new KitError(`${label} isn't installed on this PC (its scripting interface isn't registered). Install it from Creative Cloud, open it once, then try again.`, "APP_NOT_INSTALLED");
    case "BUSY":
      return new KitError(`${label} is busy and refused the script. If it's showing a dialog, close it. The step may still finish inside the app, so check before retrying.`, "APP_BUSY");
    case "GONE":
      return new KitError(`${label} isn't running anymore (it may have crashed or been closed): ${msg}`, "APP_GONE");
    case "SCRIPT":
      return new KitError(`${label} error (COM): ${msg}`, "APP_ERROR");
    case "NO_HELPER":
      return new KitError(`Komposit's Windows helper (komposit-win.exe) is missing. Reinstall Komposit.`, "NO_HELPER");
    default:
      return new KitError(`${label} error (${res.code || "helper"}): ${msg}`, "APP_ERROR");
  }
}

// The helper command line for one COM script run.
export function comArgs(app: string, scriptPath: string, outPath: string, { retryMs = 20000 } = {}): string[] {
  return ["jsx", "--progid", PROGID[app], "--script", scriptPath, "--out", outPath, "--retry-ms", String(retryMs)];
}

// The result path an AE script was wrapped to write (see envelope.ts).
export function aeResultFileOf(jsxSource: string): string | null {
  const m = /var __f = new File\(("(?:[^"\\]|\\.)*")\)/.exec(String(jsxSource));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// Wait until `path` holds complete JSON (written by another process).
export async function waitForJsonFile(path: string, { timeoutMs = 120000, signal, everyMs = 150 }: { timeoutMs?: number; signal?: AbortSignal; everyMs?: number } = {}): Promise<"ok" | "timeout" | "aborted"> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) return "aborted";
    try {
      if (existsSync(path) && statSync(path).size > 0) {
        JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
        return "ok";
      }
    } catch {}
    if (Date.now() > until) return "timeout";
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// The newest "<prefix> <year>" install under Program Files that has `rel`.
// (Filesystem paths use the host's path module: on Windows that is win32.)
export function newestAdobeExe(prefix: string, rel: string[], base = hjoin(process.env.ProgramFiles || "C:\\Program Files", "Adobe")): string | null {
  let names: string[] = [];
  try {
    names = readdirSync(base);
  } catch {
    return null;
  }
  const hits = names
    .filter((n) => n.startsWith(prefix))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((n) => hjoin(base, n, ...rel))
    .filter((p) => existsSync(p));
  return hits[0] || null;
}

// `"C:\Program Files\Adobe\...\Photoshop.exe" /automation` -> the .exe path.
export function exeFromCommand(cmd: string): string | null {
  const s = String(cmd).trim();
  const m = s.startsWith('"') ? /^"([^"]+)"/.exec(s) : /^(.+?\.exe)\b/i.exec(s);
  return m ? m[1] : s || null;
}

// One CSV line of `tasklist /FO CSV /NH` -> fields.
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

// `tasklist /FO CSV /NH` -> [{ name, pid }].
export function parseTasklist(out: string): { name: string; pid: number }[] {
  return String(out)
    .split(/\r?\n/)
    .filter((l) => l.startsWith('"'))
    .map(parseCsvLine)
    .map((f) => ({ name: f[0], pid: Number(f[1]) }))
    .filter((p) => p.name && Number.isFinite(p.pid));
}

// The helper lists the app's top-level windows (EnumWindows). Mapped to the same shape the
// Mac gives (id -> { w, h, layer }), where layer 8 means "a modal dialog" and 0 a normal
// window, so the dialog watch works unchanged:
//   - a visible window of the standard dialog class "#32770" is a dialog;
//   - so is a visible, enabled window whose owner window is disabled (a modal dialog
//     disables the window it belongs to);
//   - other visible windows are normal windows.
export function classifyWindows(list: unknown): WindowMap {
  const m: WindowMap = new Map();
  for (const w of Array.isArray(list) ? list : []) {
    if (!w || !w.visible || !w.hwnd) continue;
    const modal = w.cls === "#32770" || (!!w.owner && w.ownerEnabled === false && w.enabled !== false);
    m.set(Number(w.hwnd), { w: Math.round(w.w || 0), h: Math.round(w.h || 0), layer: modal ? 8 : 0, title: w.title || "" });
  }
  return m;
}

export interface WinTransportOptions {
  scratch?: Scratch;
  /** A built komposit-win.exe, if the caller knows where it is. */
  helperPath?: string;
  /** KompositWin.cs, to compile the helper once when none is built. */
  helperSource?: string;
  /** Where After Effects keeps its prefs. Default: %APPDATA%\Adobe\After Effects. */
  aePrefsDir?: string;
}

export function createWinTransport(opts: WinTransportOptions = {}): ScriptTransport {
  const scratch = opts.scratch || createScratch();
  const CSC = wpath.join(envDir("WINDIR", "C:\\Windows"), "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const aePrefsDir = opts.aePrefsDir || hjoin(envDir("APPDATA", hjoin(HOME, "AppData", "Roaming")), "Adobe", "After Effects");

  let helperExe: string | null = null;
  let building: Promise<string | null> | null = null;
  async function helperPath(): Promise<string | null> {
    if (helperExe && existsSync(helperExe)) return helperExe;
    helperExe = helperCandidates({ extra: opts.helperPath ? [opts.helperPath] : [] }).find((p) => existsSync(p)) || null;
    if (helperExe) return helperExe;
    // A checkout without a built helper: compile it once with the .NET Framework's
    // csc.exe (present on every Windows 10/11 PC).
    if (!building) building = buildHelper().finally(() => (building = null));
    helperExe = await building;
    return helperExe;
  }
  async function buildHelper(): Promise<string | null> {
    const src = opts.helperSource;
    if (!src || !existsSync(CSC) || !existsSync(src)) return null;
    const out = wpath.join(defaultDataDir(), "bin", "komposit-win.exe");
    mkdirSync(wpath.dirname(out), { recursive: true });
    const r = await run(CSC, cscArgs(src, out), 60000);
    return r.ok && existsSync(out) ? out : null;
  }

  // Run one helper command.
  async function helper(args: string[], { timeout = 8000, signal }: { timeout?: number; signal?: AbortSignal } = {}): Promise<HelperResult> {
    const exe = await helperPath();
    if (!exe) return { ok: false, code: "NO_HELPER", json: null, stdout: "", stderr: "komposit-win.exe is missing" };
    return new Promise((resolve) => {
      const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c: string) => (out += c));
      child.stderr.on("data", (c: string) => (err += c));
      let done = false;
      const finish = (v: HelperResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish({ ok: false, code: "TIMEOUT", json: null, stdout: out, stderr: err });
      }, timeout);
      const onAbort = () => {
        try { child.kill(); } catch {}
        finish({ ok: false, code: "ABORTED", json: null, stdout: out, stderr: err });
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
      child.on("error", (e) => finish({ ok: false, code: "SPAWN", json: null, stdout: out, stderr: e.message }));
      child.on("close", (code) => {
        let json: any = null;
        try {
          json = JSON.parse(code === 0 ? out : err);
        } catch {}
        finish({ ok: code === 0, code: code === 0 ? null : json?.code || `EXIT_${code}`, json, stdout: out, stderr: err });
      });
    });
  }

  async function tasklist() {
    const r = await run("tasklist", ["/FO", "CSV", "/NH"], 8000);
    return r.ok ? parseTasklist(r.stdout) : [];
  }

  // Running processes by base name (without .exe): [{ pid, name, path, startedMs }].
  // The helper knows start times and paths; tasklist is the fallback.
  async function processes(names: string[]): Promise<{ pid: number; name: string; path: string | null; startedMs: number | null }[]> {
    const res = await helper(["procs", "--names", names.join(",")], { timeout: 8000 });
    if (res.ok && Array.isArray(res.json)) return res.json;
    const want = new Set(names.map((n) => n.toLowerCase() + ".exe"));
    return (await tasklist()).filter((p) => want.has(p.name.toLowerCase())).map((p) => ({ pid: p.pid, name: p.name, path: null, startedMs: null }));
  }

  async function isAppRunning(app: string): Promise<boolean> {
    if (!EXE[app]) return true;
    const names = new Set((await tasklist()).map((p) => p.name.toLowerCase()));
    return names.has(EXE[app].toLowerCase());
  }

  async function appPid(app: string): Promise<number | null> {
    if (!EXE[app]) return null;
    const p = (await tasklist()).find((x) => x.name.toLowerCase() === EXE[app].toLowerCase());
    return p ? p.pid : null;
  }

  async function appWindows(app: string): Promise<WindowMap | null> {
    if (!EXE[app]) return null;
    const res = await helper(["windows", "--names", exeBase(app)], { timeout: 4000 });
    if (!res.ok || !Array.isArray(res.json)) return null;
    return classifyWindows(res.json);
  }

  // Where AfterFX.exe is: the running After Effects' own path, then the App Paths registry
  // entry, then the newest "Adobe After Effects *" folder.
  let aeExe: string | null = null;
  async function afterEffectsExe(): Promise<string | null> {
    if (aeExe && existsSync(aeExe)) return aeExe;
    const procs = await processes(["AfterFX"]);
    const running = procs.find((p) => p.path && existsSync(p.path));
    if (running?.path) return (aeExe = running.path);
    const r = await run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AfterFX.exe", "/ve"], 5000);
    const fromReg = r.ok ? parseRegQuery(r.stdout)["(Default)"] : null;
    if (fromReg && existsSync(fromReg)) return (aeExe = fromReg);
    return (aeExe = newestAdobeExe("Adobe After Effects", ["Support Files", "AfterFX.exe"]));
  }

  // Premiere Pro (reached through Komposit's panel, not COM): the running one, else the newest
  // "Adobe Premiere Pro <year>" under Program Files.
  async function premiereExe(): Promise<string | null> {
    const procs = await processes(["Adobe Premiere Pro"]);
    const running = procs.find((p) => p.path && existsSync(p.path));
    if (running?.path) return running.path;
    return newestAdobeExe("Adobe Premiere Pro", ["Adobe Premiere Pro.exe"]);
  }

  // The program registered for a ProgID (HKCR\<ProgID>\CLSID -> LocalServer32).
  async function comServerPath(progId: string): Promise<string | null> {
    const c = await run("reg", ["query", `HKCR\\${progId}\\CLSID`, "/ve"], 5000);
    const clsid = c.ok ? parseRegQuery(c.stdout)["(Default)"] : null;
    if (!clsid) return null;
    const s = await run("reg", ["query", `HKCR\\CLSID\\${clsid}\\LocalServer32`, "/ve"], 5000);
    const cmd = s.ok ? parseRegQuery(s.stdout)["(Default)"] : null;
    return cmd ? exeFromCommand(cmd) : null;
  }

  async function modalUp(): Promise<boolean> {
    const m = await appWindows("aftereffects");
    return !!m && [...m.values()].some((s) => s.layer === 8 && s.w >= 150 && s.h >= 80);
  }

  // After Effects. `AfterFX.exe -r <file>` passes the script to the running After Effects
  // and returns; the script writes its JSON result to the file named inside it. So: run
  // the launcher, then wait until the result file holds complete JSON. Resolves with ""
  // either way: the caller reads the result file itself, and treats a missing file the
  // same way as on the Mac.
  async function runAfterEffects(jsxSource: string, { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }): Promise<string> {
    const exe = await afterEffectsExe();
    if (!exe) throw new KitError("After Effects isn't installed on this PC (AfterFX.exe wasn't found).", "APP_NOT_INSTALLED");
    const jsxPath = scratch.name("exec", "jsx");
    // A UTF-8 byte order mark makes ExtendScript read the file as UTF-8.
    writeFileSync(jsxPath, "\uFEFF" + jsxSource, "utf8");
    const resultFile = aeResultFileOf(jsxSource);
    // With "Allow Scripts to Write Files" off, the script runs but can't write its
    // result. The Mac sees that at once; here, only by waiting. So when the prefs file
    // says it's off, wait briefly, then let the caller report it.
    const writes = aeScriptWritesPref(aePrefsDir);
    // Wait on the result file only, never on the launcher: it normally returns at once,
    // and if it doesn't, the step's timeout still holds. It's never killed either (with
    // no After Effects running, it IS After Effects).
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal) {
      if (signal.aborted) throw new KitError("stopped", "STOPPED");
      signal.addEventListener("abort", onAbort, { once: true });
    }
    let launchError: Error | null = null;
    try {
      const child = spawn(exe, ["-r", jsxPath], { windowsHide: true, stdio: "ignore", detached: true });
      child.on("error", (e) => {
        launchError = e;
        ac.abort();
      });
      child.unref();
      if (!resultFile) return "";
      const ok = await waitForJsonFile(resultFile, { timeoutMs: writes === false ? Math.min(timeoutMs, 10000) : timeoutMs, signal: ac.signal });
      if (launchError) throw new KitError(`After Effects' script launcher (AfterFX.exe) didn't start: ${(launchError as Error).message}`, "SPAWN");
      if (ok === "aborted") throw new KitError("stopped", "STOPPED");
      if (ok === "timeout" && writes !== false && !(await modalUp())) throw new KitError(TIMEOUT_TEXT("After Effects"), "TIMEOUT");
      return ""; // the caller reads the result file, or reports a dialog / blocked writes
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
      // The launcher may return before After Effects has read the file; give it time
      // before removing it.
      setTimeout(() => rmQuiet(jsxPath), 60000).unref?.();
    }
  }

  // Windows has no per-app automation permission: COM is open to the person's own
  // programs. So "allowed" means "a script ran", remembered for that run of the app (its
  // process id); until then the state is unknown.
  const connected = new Map<string, number>();
  async function noteConnected(app: string) {
    const pid = await appPid(app);
    if (pid) connected.set(app, pid);
  }

  let starts = new Map<number, number>();

  return {
    platform: "win",
    aeScriptSettings: "Edit > Preferences > Scripting & Expressions",

    // via "stdout": Illustrator and Photoshop return the script's last expression
    // (DoJavaScript). via "file": After Effects; the script itself writes the result file
    // and this waits for the launcher to hand it over.
    async runJsx(app, jsxSource, { via = "stdout", timeoutMs = 120000, signal }: RunJsxOptions = {}) {
      if (app === "aftereffects" || via === "file") {
        const out = await runAfterEffects(jsxSource, { timeoutMs, signal });
        if (!connected.has(app)) await noteConnected(app).catch(() => {});
        return out;
      }
      if (!PROGID[app]) throw new KitError(`Komposit can't script "${app}".`, "UNKNOWN_APP");
      const jsxPath = scratch.name("exec", "jsx");
      const outPath = scratch.name("result", "txt");
      writeFileSync(jsxPath, jsxSource, "utf8");
      try {
        const res = await helper(comArgs(app, jsxPath, outPath, { retryMs: Math.min(30000, timeoutMs) }), { timeout: timeoutMs, signal });
        if (res.code === "ABORTED") throw new KitError("stopped", "STOPPED");
        if (res.code === "TIMEOUT") throw new KitError(TIMEOUT_TEXT(labelOf(app)), "TIMEOUT");
        if (!res.ok) throw comError(app, res);
        if (!connected.has(app)) await noteConnected(app).catch(() => {});
        return existsSync(outPath) ? readFileSync(outPath, "utf8").replace(/^\uFEFF/, "").trim() : "";
      } finally {
        rmQuiet(jsxPath);
        rmQuiet(outPath);
      }
    },

    isAppRunning,
    appPid,

    async processUptime(pid) {
      if (!starts.has(pid)) {
        const procs = await processes(Object.values(EXE).map((e) => e.replace(/\.exe$/i, "")));
        starts = new Map(procs.filter((p) => p.startedMs).map((p) => [p.pid, p.startedMs as number]));
      }
      const started = starts.get(pid);
      // Unknown start time: don't hold scripts back for it.
      return started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 3600;
    },

    appWindows,

    // For now Windows gives a dialog's title (the helper already lists window titles); its
    // text and buttons, and answering it, need the helper to read and press the dialog's
    // controls, which it doesn't do yet.
    async dialogs(app) {
      const m = await appWindows(app);
      if (!m) return { dialogs: [] };
      const out: DialogBox[] = [];
      for (const w of m.values()) if (w.layer === 8 && w.w >= 150 && w.h >= 80) out.push({ kind: "dialog", title: w.title || "", text: [], buttons: [], fields: 0 });
      return { dialogs: out };
    },
    async answerDialog() {
      return { ok: false, reason: "Answering dialogs isn't available on Windows yet." };
    },

    // Where each app's program is: the COM registration for Illustrator and Photoshop
    // (LocalServer32), AfterFX.exe for After Effects.
    async installedPath(app) {
      if (app === "aftereffects") return afterEffectsExe();
      if (app === "premiere") return premiereExe();
      return PROGID[app] ? comServerPath(PROGID[app]) : null;
    },

    // Bring an app to the front; start it if it isn't running.
    async activateApp(app) {
      if (!(await isAppRunning(app))) {
        const exe = app === "aftereffects" ? await afterEffectsExe() : PROGID[app] ? await comServerPath(PROGID[app]) : null;
        if (!exe) return;
        try {
          const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: false });
          child.on("error", () => {});
          child.unref();
        } catch {}
        return;
      }
      await helper(["activate", "--names", exeBase(app)], { timeout: 8000 });
    },

    async automationState(app): Promise<AutomationState> {
      const pid = await appPid(app);
      if (!pid) return "not-running";
      return connected.get(app) === pid ? "allowed" : "unknown";
    },

    aeScriptWrites() {
      return aeScriptWritesPref(aePrefsDir);
    },
  };
}
