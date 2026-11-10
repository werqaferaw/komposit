// Windows: how Komposit talks to the system and the Adobe apps on a PC.
// The macOS counterpart is mac.mjs; both export the same names (index.mjs).
//
// The Adobe apps:
//   Illustrator, Photoshop  COM automation: "Illustrator.Application" /
//                           "Photoshop.Application" DoJavaScript(code) returns
//                           the script's last expression (as `do javascript`
//                           does on the Mac).
//   After Effects           no COM. `AfterFX.exe -r <file.jsx>` hands the script
//                           to the running After Effects; the wrapped script
//                           writes its result to a file, which we wait for.
//
// System calls go through komposit-win.exe (packaging/windows/helper), a small
// .NET Framework program: COM calls (with a message filter that retries while
// the app is busy), process and window lists (for the dialog notice), known
// folders, opening files, thumbnails. Every Windows 10/11 PC has .NET Framework
// 4.8, so a checkout without a built helper compiles it once with the
// framework's own csc.exe.
//
// Pure helpers (command lines, parsers) are exported so they can be unit-tested
// on any OS; they use path.win32 so the results are Windows paths everywhere.
import { spawn, execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { win32 as wpath, dirname as hostDirname, join as hjoin } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { scratchName, rmQuiet } from "../scratch.mjs";

export const name = "win";
export const device = "PC";
export const keys = { mod: "Ctrl" };

const HOME = homedir();
const ROOT = wpath.resolve(hostDirname(fileURLToPath(import.meta.url)), "..", "..");
const LABEL = { illustrator: "Illustrator", photoshop: "Photoshop", aftereffects: "After Effects" };

function envDir(key, fallback) {
  return process.env[key] || fallback;
}

// ---------- paths ----------

export function defaultDataDir() {
  return wpath.join(envDir("APPDATA", wpath.join(HOME, "AppData", "Roaming")), "Komposit");
}

export function logFile() {
  return wpath.join(envDir("LOCALAPPDATA", wpath.join(HOME, "AppData", "Local")), "Komposit", "Logs", "server.log");
}

// Is `p` the folder `dir` or inside it? Windows paths are case-insensitive and
// take either slash; ../ tricks are resolved away first.
export function isInside(dir, p) {
  if (!p || typeof p !== "string" || !dir) return false;
  const r = wpath.resolve(p).toLowerCase();
  const d = wpath.resolve(dir).toLowerCase().replace(/\\+$/, "");
  return r === d || r.startsWith(d + "\\");
}

// `reg query` output -> { valueName: data } (REG_SZ and REG_EXPAND_SZ).
export function parseRegQuery(out) {
  const values = {};
  for (const line of String(out).split(/\r?\n/)) {
    const m = /^\s{2,}(.+?)\s{2,}(REG_\w+)\s{2,}(.*)$/.exec(line);
    if (m) values[m[1]] = m[3].trim();
  }
  return values;
}

// Expand %VAR% from an environment object (case-insensitive names).
export function expandEnv(s, env = process.env) {
  const lower = Object.fromEntries(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return String(s).replace(/%([^%]+)%/g, (all, k) => lower[k.toLowerCase()] ?? all);
}

const SHELL_FOLDERS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";
const DOWNLOADS_GUID = "{374DE290-123F-4565-9164-39C4925E467B}";

// Desktop, Documents and Downloads where Windows really keeps them: OneDrive's
// Known Folder Move redirects Desktop and Documents into OneDrive, and people
// move Downloads. Falls back to the profile folders.
export function knownFoldersFrom(values, env = process.env, home = HOME) {
  const pick = (v, fallback) => (v ? expandEnv(v, env) : wpath.join(home, fallback));
  return {
    desktop: pick(values.Desktop, "Desktop"),
    downloads: pick(values[DOWNLOADS_GUID], "Downloads"),
    documents: pick(values.Personal, "Documents"),
  };
}

let _folders = null;
export async function designFolders() {
  if (_folders) return _folders;
  const r = await run("reg", ["query", SHELL_FOLDERS], 5000);
  _folders = knownFoldersFrom(r.ok ? parseRegQuery(r.stdout) : {});
  return _folders;
}

// No permission prompts for the profile folders on Windows.
export const folderPrompts = false;

// ---------- running programs ----------

function run(cmd, args, timeout = 8000, opts = {}) {
  return new Promise((res) => {
    execFile(cmd, args, { timeout, encoding: "utf8", windowsHide: true, maxBuffer: 8 << 20, ...opts }, (err, stdout, stderr) =>
      res({ ok: !err, code: err?.code, stdout: stdout || "", stderr: stderr || "", err }),
    );
  });
}

// ---------- the helper (komposit-win.exe) ----------

const CSC = wpath.join(envDir("WINDIR", "C:\\Windows"), "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const HELPER_SRC = wpath.join(ROOT, "packaging", "windows", "helper", "KompositWin.cs");

// Where a built helper can be: set by the tray app, next to the bundled node,
// one level above the app folder (the installed layout), the repo's build
// folder, or compiled on demand into the data folder.
export function helperCandidates({ env = process.env, execPath = process.execPath, root = ROOT, dataDir = defaultDataDir() } = {}) {
  return [
    env.KOMPOSIT_WIN_HELPER,
    wpath.join(wpath.dirname(execPath), "komposit-win.exe"),
    wpath.join(root, "..", "komposit-win.exe"),
    wpath.join(root, "packaging", "windows", "build", "komposit-win.exe"),
    wpath.join(dataDir, "bin", "komposit-win.exe"),
  ].filter(Boolean);
}

let _helper = null;
let _building = null;
export async function helperPath() {
  if (_helper && existsSync(_helper)) return _helper;
  _helper = helperCandidates().find((p) => existsSync(p)) || null;
  if (_helper) return _helper;
  // A checkout without a built helper: compile it once with the .NET
  // Framework's csc.exe (present on every Windows 10/11 PC).
  if (!_building) _building = buildHelper().finally(() => (_building = null));
  _helper = await _building;
  return _helper;
}

// The csc.exe command line that builds the helper from its one source file.
export function cscArgs(src, out) {
  return ["/nologo", "/optimize+", "/target:exe", "/platform:anycpu", `/out:${out}`, "/r:System.Drawing.dll", src];
}

async function buildHelper() {
  if (!existsSync(CSC) || !existsSync(HELPER_SRC)) return null;
  const out = wpath.join(defaultDataDir(), "bin", "komposit-win.exe");
  mkdirSync(wpath.dirname(out), { recursive: true });
  const r = await run(CSC, cscArgs(HELPER_SRC, out), 60000);
  return r.ok && existsSync(out) ? out : null;
}

// Run one helper command. Resolves { ok, code, json, stdout, stderr }.
async function helper(args, { timeout = 8000, signal } = {}) {
  const exe = await helperPath();
  if (!exe) return { ok: false, code: "NO_HELPER", json: null, stdout: "", stderr: "komposit-win.exe is missing" };
  return new Promise((resolve) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    let done = false;
    const finish = (v) => {
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
      let json = null;
      try { json = JSON.parse(code === 0 ? out : err); } catch {}
      finish({ ok: code === 0, code: code === 0 ? null : json?.code || `EXIT_${code}`, json, stdout: out, stderr: err });
    });
  });
}

// ---------- the ExtendScript transport ----------

export const PROGID = { illustrator: "Illustrator.Application", photoshop: "Photoshop.Application" };
// Program file names, as tasklist and the process list show them.
export const EXE = { illustrator: "Illustrator.exe", photoshop: "Photoshop.exe", aftereffects: "AfterFX.exe" };

export function target(app) {
  return PROGID[app] || EXE[app] || app;
}

// The helper command line for one COM script run.
export function comArgs(app, scriptPath, outPath, { retryMs = 20000 } = {}) {
  return ["jsx", "--progid", PROGID[app], "--script", scriptPath, "--out", outPath, "--retry-ms", String(retryMs)];
}

// A helper failure -> the error the bridges and the incident log understand.
// The wording mirrors the Mac's where the cause is the same.
export function comError(app, res) {
  const label = LABEL[app] || app;
  const msg = String(res.json?.error || res.stderr || "").trim();
  const e = new Error(msg || `${label} didn't run the script.`);
  switch (res.code) {
    case "NOT_INSTALLED":
      e.message = `${label} isn't installed on this PC (its scripting interface isn't registered). Install it from Creative Cloud, open it once, then try again.`;
      e.code = "APP_NOT_INSTALLED";
      break;
    case "BUSY":
      e.message = `${label} is busy and refused the script. If it's showing a dialog, close it. The step may still finish inside the app, so check before retrying.`;
      e.code = "APP_BUSY";
      break;
    case "GONE":
      e.message = `${label} isn't running anymore (it may have crashed or been closed): ${msg}`;
      e.code = "APP_GONE";
      break;
    case "SCRIPT":
      e.message = `${label} error (COM): ${msg}`;
      break;
    case "NO_HELPER":
      e.message = `Komposit's Windows helper (komposit-win.exe) is missing. Reinstall Komposit.`;
      e.code = "NO_HELPER";
      break;
    default:
      e.message = `${label} error (${res.code || "helper"}): ${msg}`;
  }
  return e;
}

// Run a jsx source string inside the app. via "stdout": Illustrator and
// Photoshop return the script's last expression (DoJavaScript). via "file":
// After Effects; the script itself writes the result file and this waits for
// the launcher to hand it over. Resolves with the returned text.
export async function runJsx(app, jsxSource, { via = "stdout", timeoutMs = 120000, signal } = {}) {
  if (app === "aftereffects" || via === "file") return runAfterEffects(jsxSource, { timeoutMs, signal });
  if (!PROGID[app]) throw new Error(`Unknown app "${app}".`);
  const jsxPath = scratchName("exec", "jsx");
  const outPath = scratchName("result", "txt");
  writeFileSync(jsxPath, jsxSource, "utf8");
  try {
    const res = await helper(comArgs(app, jsxPath, outPath, { retryMs: Math.min(30000, timeoutMs) }), { timeout: timeoutMs, signal });
    if (res.code === "ABORTED") throw new Error("stopped");
    if (res.code === "TIMEOUT") {
      throw new Error(`${LABEL[app]} didn't answer in time. If it's showing a dialog, close it. The step may still finish inside the app, so check before retrying.`);
    }
    if (!res.ok) throw comError(app, res);
    return existsSync(outPath) ? readFileSync(outPath, "utf8").replace(/^\uFEFF/, "").trim() : "";
  } finally {
    rmQuiet(jsxPath);
    rmQuiet(outPath);
  }
}

// After Effects. `AfterFX.exe -r <file>` passes the script to the running
// After Effects and returns; the script writes its JSON result to the file
// named inside it (extendscript.mjs wraps every AE script that way). So: run
// the launcher, then wait until the result file holds complete JSON.
// Resolves with "" either way: the caller reads the result file itself, and
// treats a missing file the same way as on the Mac.
async function runAfterEffects(jsxSource, { timeoutMs, signal }) {
  const exe = await afterEffectsExe();
  if (!exe) {
    const e = new Error("After Effects isn't installed on this PC (AfterFX.exe wasn't found).");
    e.code = "APP_NOT_INSTALLED";
    throw e;
  }
  const jsxPath = scratchName("exec", "jsx");
  // A UTF-8 byte order mark makes ExtendScript read the file as UTF-8.
  writeFileSync(jsxPath, "\uFEFF" + jsxSource, "utf8");
  const resultFile = aeResultFileOf(jsxSource);
  // With "Allow Scripts to Write Files" off, the script runs but can't write
  // its result. The Mac sees that at once; here, only by waiting. So when the
  // prefs file says it's off, wait briefly, then let the caller report it.
  const writes = aeScriptWritesPref();
  // Wait on the result file only, never on the launcher: it normally returns
  // at once, and if it doesn't, the step's timeout still holds. It's never
  // killed either (with no After Effects running, it IS After Effects).
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) throw new Error("stopped");
    signal.addEventListener("abort", onAbort, { once: true });
  }
  let launchError = null;
  try {
    const child = spawn(exe, ["-r", jsxPath], { windowsHide: true, stdio: "ignore", detached: true });
    child.on("error", (e) => {
      launchError = e;
      ac.abort();
    });
    child.unref();
    if (!resultFile) return "";
    const ok = await waitForJsonFile(resultFile, { timeoutMs: writes === false ? Math.min(timeoutMs, 10000) : timeoutMs, signal: ac.signal });
    if (launchError) throw new Error(`Failed to start AfterFX.exe: ${launchError.message}`);
    if (ok === "aborted") throw new Error("stopped");
    if (ok === "timeout" && writes !== false && !(await modalUp())) {
      throw new Error("After Effects didn't answer in time. If it's showing a dialog, close it. The step may still finish inside the app, so check before retrying.");
    }
    return ""; // the caller reads the result file, or reports a dialog / blocked writes
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    // The launcher may return before After Effects has read the file; give it
    // time before removing it.
    setTimeout(() => rmQuiet(jsxPath), 60000).unref?.();
  }
}

async function modalUp() {
  const m = await appWindows("aftereffects");
  return !!m && [...m.values()].some((s) => s.layer === 8 && s.w >= 150 && s.h >= 80);
}

// After Effects' "Allow Scripts to Write Files and Access Network", from its
// prefs file: true, false, or null when unknown. Key in ["Main Pref Section v2"]:
//   "Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "1"
export function parseAePref(text, key = "Pref_SCRIPTING_FILE_NETWORK_SECURITY") {
  const m = new RegExp(`"${key}"\\s*=\\s*"?(\\d)"?`).exec(String(text));
  return m ? m[1] === "1" : null;
}

// The newest "Adobe After Effects <ver> Prefs.txt" under %APPDATA%\Adobe\After Effects.
export function aeScriptWritesPref(base = hjoin(envDir("APPDATA", hjoin(HOME, "AppData", "Roaming")), "Adobe", "After Effects")) {
  try {
    const files = readdirSync(base)
      .map((v) => hjoin(base, v, `Adobe After Effects ${v} Prefs.txt`))
      .filter((f) => existsSync(f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files.length ? parseAePref(readFileSync(files[0], "latin1")) : null;
  } catch {
    return null;
  }
}

// The result path an AE script was wrapped to write (see extendscript.mjs).
export function aeResultFileOf(jsxSource) {
  const m = /var __f = new File\(("(?:[^"\\]|\\.)*")\)/.exec(String(jsxSource));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// Wait until `path` holds complete JSON (written by another process).
export async function waitForJsonFile(path, { timeoutMs = 120000, signal, everyMs = 150 } = {}) {
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

// Where AfterFX.exe is: the running After Effects' own path, then the App
// Paths registry entry, then the newest "Adobe After Effects *" folder.
let _aeExe = null;
export async function afterEffectsExe() {
  if (_aeExe && existsSync(_aeExe)) return _aeExe;
  const procs = await processes(["AfterFX"]);
  const running = procs.find((p) => p.path && existsSync(p.path));
  if (running) return (_aeExe = running.path);
  const r = await run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AfterFX.exe", "/ve"], 5000);
  const fromReg = r.ok ? parseRegQuery(r.stdout)["(Default)"] : null;
  if (fromReg && existsSync(fromReg)) return (_aeExe = fromReg);
  return (_aeExe = newestAdobeExe("Adobe After Effects", ["Support Files", "AfterFX.exe"]));
}

// The newest "<prefix> <year>" install under Program Files that has `rel`.
// (Filesystem paths use the host's path module: on Windows that is win32.)
export function newestAdobeExe(prefix, rel, base = hjoin(process.env.ProgramFiles || "C:\\Program Files", "Adobe")) {
  let names = [];
  try { names = readdirSync(base); } catch { return null; }
  const hits = names
    .filter((n) => n.startsWith(prefix))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((n) => hjoin(base, n, ...rel))
    .filter((p) => existsSync(p));
  return hits[0] || null;
}

// Bring an app to the front; start it if it isn't running.
export async function activateApp(app) {
  const running = await isAppRunning(app);
  if (!running) return void (await launchApp(app));
  await helper(["activate", "--names", exeBase(app)], { timeout: 8000 });
}

// Where After Effects' "Allow Scripts to Write Files" setting lives here.
export const aeScriptSettings = "Edit > Preferences > Scripting & Expressions";

// ---------- processes ----------

const exeBase = (app) => (EXE[app] || "").replace(/\.exe$/i, "");

// One CSV line of `tasklist /FO CSV /NH` -> fields.
export function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// `tasklist /FO CSV /NH` -> [{ name, pid }].
export function parseTasklist(out) {
  return String(out)
    .split(/\r?\n/)
    .filter((l) => l.startsWith('"'))
    .map(parseCsvLine)
    .map((f) => ({ name: f[0], pid: Number(f[1]) }))
    .filter((p) => p.name && Number.isFinite(p.pid));
}

async function tasklist() {
  const r = await run("tasklist", ["/FO", "CSV", "/NH"], 8000);
  return r.ok ? parseTasklist(r.stdout) : [];
}

// Running processes by base name (without .exe): [{ pid, name, path, startedMs, nowMs }].
// The helper knows start times and paths; tasklist is the fallback.
export async function processes(names) {
  const res = await helper(["procs", "--names", names.join(",")], { timeout: 8000 });
  if (res.ok && Array.isArray(res.json)) return res.json;
  const want = new Set(names.map((n) => n.toLowerCase() + ".exe"));
  return (await tasklist()).filter((p) => want.has(p.name.toLowerCase())).map((p) => ({ pid: p.pid, name: p.name, path: null, startedMs: null, nowMs: null }));
}

export async function runningApps() {
  const procs = await tasklist();
  const names = new Set(procs.map((p) => p.name.toLowerCase()));
  return Object.fromEntries(Object.entries(EXE).map(([id, exe]) => [id, names.has(exe.toLowerCase())]));
}

export async function isAppRunning(app) {
  if (!EXE[app]) return true;
  return (await runningApps())[app];
}

export async function appPid(app) {
  if (!EXE[app]) return null;
  const p = (await tasklist()).find((x) => x.name.toLowerCase() === EXE[app].toLowerCase());
  return p ? p.pid : null;
}

let _starts = new Map();
export async function processUptime(pid) {
  if (!_starts.has(pid)) {
    const procs = await processes(Object.values(EXE).map((e) => e.replace(/\.exe$/i, "")));
    _starts = new Map(procs.filter((p) => p.startedMs).map((p) => [p.pid, p.startedMs]));
  }
  const started = _starts.get(pid);
  // Unknown start time: don't hold scripts back for it.
  return started ? Math.max(0, Math.round((Date.now() - started) / 1000)) : 3600;
}

// ---------- windows (dialog notice) ----------
//
// The helper lists the app's top-level windows (EnumWindows). Mapped to the
// same shape the Mac gives (id -> { w, h, layer }), where layer 8 means "a
// modal dialog" and 0 a normal window, so dialogwatch.mjs works unchanged:
//   - a visible window of the standard dialog class "#32770" is a dialog;
//   - so is a visible, enabled window whose owner window is disabled (a modal
//     dialog disables the window it belongs to);
//   - other visible windows are normal windows.
export function classifyWindows(list) {
  const m = new Map();
  for (const w of Array.isArray(list) ? list : []) {
    if (!w || !w.visible || !w.hwnd) continue;
    const modal = w.cls === "#32770" || (!!w.owner && w.ownerEnabled === false && w.enabled !== false);
    m.set(Number(w.hwnd), { w: Math.round(w.w || 0), h: Math.round(w.h || 0), layer: modal ? 8 : 0, title: w.title || "" });
  }
  return m;
}

export async function appWindows(app) {
  if (!EXE[app]) return null;
  const res = await helper(["windows", "--names", exeBase(app)], { timeout: 4000 });
  if (!res.ok || !Array.isArray(res.json)) return null;
  return classifyWindows(res.json);
}

// ---------- installed apps, launching, permissions ----------

// Kept for the shared interface; Windows has no bundle ids.
export const BUNDLE_IDS = { illustrator: null, photoshop: null, aftereffects: null };

// Where each app's program is, or null: the COM registration for Illustrator
// and Photoshop (LocalServer32), AfterFX.exe for After Effects.
export async function installedApps() {
  const out = {};
  await Promise.all(
    Object.keys(EXE).map(async (id) => {
      if (id === "aftereffects") {
        out[id] = await afterEffectsExe();
        return;
      }
      out[id] = await comServerPath(PROGID[id]);
    }),
  );
  return out;
}

// The program registered for a ProgID (HKCR\<ProgID>\CLSID -> LocalServer32).
export async function comServerPath(progId) {
  const c = await run("reg", ["query", `HKCR\\${progId}\\CLSID`, "/ve"], 5000);
  const clsid = c.ok ? parseRegQuery(c.stdout)["(Default)"] : null;
  if (!clsid) return null;
  const s = await run("reg", ["query", `HKCR\\CLSID\\${clsid}\\LocalServer32`, "/ve"], 5000);
  const cmd = s.ok ? parseRegQuery(s.stdout)["(Default)"] : null;
  return cmd ? exeFromCommand(cmd) : null;
}

// `"C:\Program Files\Adobe\...\Photoshop.exe" /automation` -> the .exe path.
export function exeFromCommand(cmd) {
  const s = String(cmd).trim();
  const m = s.startsWith('"') ? /^"([^"]+)"/.exec(s) : /^(.+?\.exe)\b/i.exec(s);
  return m ? m[1] : s || null;
}

export async function launchApp(app) {
  const paths = await installedApps();
  const exe = paths[app];
  if (!exe) return { ok: false };
  try {
    const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => {});
    child.unref();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// Windows has no per-app automation permission: COM is open to the person's
// own programs. So "allowed" means "a test script ran", remembered for that
// run of the app (its process id); until then the state is unknown and the UI
// offers "Test connection".
const _connected = new Map(); // app -> pid that answered a test script
export async function noteConnected(app) {
  const pid = await appPid(app);
  if (pid) _connected.set(app, pid);
}
export async function automationState(app) {
  const pid = await appPid(app);
  if (!pid) return "not-running";
  return _connected.get(app) === pid ? "allowed" : "unknown";
}

export async function openSettingsPane() {
  return { ok: false };
}

// Open a file in the app that owns it (ShellExecute "open").
export async function openPath(path) {
  const res = await helper(["open", "--path", path], { timeout: 15000 });
  return res.ok;
}

// The Explorer thumbnail of `path` (400 px PNG), or null. Many .ai/.psd files
// have none unless a thumbnail handler is installed; open files get real
// renders instead.
export async function thumbnail(path, outDir, cachedPath) {
  const res = await helper(["thumb", "--path", path, "--out", cachedPath, "--size", "400"], { timeout: 20000 });
  if (!res.ok) return null;
  try {
    return await readFile(cachedPath);
  } catch {
    return null;
  }
}

// ---------- the person's environment (Claude Code) ----------

// Programs started from the Start menu get the PATH Explorer had at sign-in;
// one installed since (Claude Code, say) is only in the registry. Read the
// current user and system PATH from there.
export async function loginPath() {
  const [u, m] = await Promise.all([
    run("reg", ["query", "HKCU\\Environment", "/v", "Path"], 5000),
    run("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "/v", "Path"], 5000),
  ]);
  const parts = [m, u].map((r) => (r.ok ? parseRegQuery(r.stdout).Path || "" : "")).filter(Boolean);
  return parts.map((p) => expandEnv(p)).join(";");
}

// Usual places Claude Code is installed on Windows.
export function extraBinDirs() {
  const appdata = envDir("APPDATA", wpath.join(HOME, "AppData", "Roaming"));
  const local = envDir("LOCALAPPDATA", wpath.join(HOME, "AppData", "Local"));
  return [
    wpath.join(HOME, ".local", "bin"), // the native installer (install.ps1)
    wpath.join(appdata, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin"), // npm's real binary
    wpath.join(appdata, "npm"),
    wpath.join(local, "Programs", "claude"),
    wpath.join(HOME, ".bun", "bin"),
    wpath.join(local, "Volta", "bin"),
  ];
}

export const systemPathDirs = [];

// Only real executables: Node refuses to spawn .cmd/.bat without a shell, and
// a shell would have to quote the person's whole message.
export const claudeNames = ["claude.exe"];

// The same for Codex. npm only puts codex.cmd on the PATH; shellenv.mjs then
// finds the native codex.exe inside the npm package.
export const codexNames = ["codex.exe"];

// ---------- child processes ----------

// No process groups on Windows; hide the console window instead.
export const groupSpawnOptions = { windowsHide: true };

// taskkill /T kills the child and everything it started (the doc server).
export function killTree(child) {
  if (!child?.pid) return;
  try {
    const k = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    k.on("error", () => {
      try { child.kill(); } catch {}
    });
  } catch {
    try { child.kill(); } catch {}
  }
}

// Started by the tray app: Windows doesn't re-parent orphans, so check that
// the parent is still alive. (The tray also puts the server in a job object
// that ends it when the tray goes away.)
export function watchParent(onOrphan, parent = process.ppid) {
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch (e) {
      if (e.code === "ESRCH") onOrphan();
    }
  }, 2000).unref();
}
