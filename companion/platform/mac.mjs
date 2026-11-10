// macOS: how Komposit talks to the system and the Adobe apps on a Mac.
//
// AppleScript and JXA for the Adobe apps and window lists; pgrep, ps, mdfind,
// open and qlmanage for processes, installed apps, files and thumbnails. The
// Windows counterpart is win.mjs; both export the same names (see index.mjs),
// and nothing outside companion/platform/ calls these tools directly.
import { spawn, execFile } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { join, dirname, basename, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { scratchDir, scratchName, rmQuiet } from "../scratch.mjs";

export const name = "mac";
export const device = "Mac";
// Keyboard words the model uses when it talks to the person.
export const keys = { mod: "Cmd" };

const HOME = homedir();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function run(cmd, args, timeout = 8000) {
  return new Promise((res) => {
    execFile(cmd, args, { timeout, encoding: "utf8" }, (err, stdout, stderr) =>
      res({ ok: !err, code: err?.code, stdout: stdout || "", stderr: stderr || "" }),
    );
  });
}

// ---------- paths ----------

export function defaultDataDir() {
  return join(HOME, "Library", "Application Support", "Komposit");
}

export function logFile() {
  return join(HOME, "Library", "Logs", "Komposit", "server.log");
}

// Is `p` the folder `dir` or inside it (no ../ tricks)? Case-sensitive, like
// the rest of macOS path handling here.
export function isInside(dir, p) {
  if (!p || typeof p !== "string") return false;
  const r = resolve(p);
  const d = resolve(dir);
  return r === d || r.startsWith(d + sep);
}

// Where designs live: Desktop, Downloads, Documents in the home folder.
export async function designFolders() {
  return { desktop: join(HOME, "Desktop"), downloads: join(HOME, "Downloads"), documents: join(HOME, "Documents") };
}

// Reading Desktop, Documents or Downloads the first time shows a macOS
// permission prompt (TCC), so Komposit only reads them once the person asks.
export const folderPrompts = true;

// ---------- the ExtendScript transport (AppleScript) ----------

// AppleScript targets. Photoshop by bundle id (version-independent); After
// Effects' app name is version-stamped, override with AE_APP.
const TARGET = {
  illustrator: 'application "Adobe Illustrator"',
  photoshop: 'application id "com.adobe.Photoshop"',
  aftereffects: `application ${JSON.stringify(process.env.AE_APP || "Adobe After Effects 2026")}`,
};
export function target(app) {
  return TARGET[app] || app;
}

// "application \"Adobe Illustrator\"" or "application id \"com.adobe.Photoshop\"" -> a name.
function appLabel(target) {
  const m = String(target).match(/"([^"]+)"/);
  const s = m ? m[1] : String(target);
  if (/photoshop/i.test(s)) return "Photoshop";
  if (/illustrator/i.test(s)) return "Illustrator";
  if (/after effects/i.test(s)) return "After Effects";
  return s;
}

// Run a jsx source string inside the app via AppleScript, without blocking
// the server while the app works. `via` is "stdout" (`do javascript` returns
// the script's last expression) or "file" (After Effects' `DoScript` returns
// nothing; the script writes its result to a file). Resolves with stdout;
// rejects on error, timeout or abort.
export function runJsx(app, jsxSource, { via = "stdout", timeoutMs = 120000, signal } = {}) {
  const target = TARGET[app] || app;
  const verb = via === "file" ? "DoScript" : "do javascript";
  const jsxPath = scratchName("exec", "jsx");
  const scptPath = scratchName("exec", "applescript");
  writeFileSync(jsxPath, jsxSource, "utf8");

  // Reading the jsx from a file inside AppleScript avoids all shell/AppleScript
  // escaping of the script body.
  const applescript =
    `set jsxText to (read (POSIX file ${JSON.stringify(jsxPath)}) as «class utf8»)\n` +
    `with timeout of ${Math.ceil(timeoutMs / 1000) + 5} seconds\n` +
    `tell ${target}\n` +
    `  ${verb} jsxText\n` +
    `end tell\n` +
    `end timeout\n`;
  writeFileSync(scptPath, applescript, "utf8");

  return new Promise((resolve, reject) => {
    const child = spawn("osascript", [scptPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));

    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      rmQuiet(jsxPath);
      rmQuiet(scptPath);
      fn(v);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(
        reject,
        new Error(`${appLabel(target)} didn't answer in time. If it's showing a dialog, close it. The step may still finish inside the app, so check before retrying.`),
      );
    }, timeoutMs);
    const onAbort = () => {
      try { child.kill("SIGKILL"); } catch {}
      finish(reject, new Error("stopped"));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (e) => finish(reject, new Error(`Failed to launch osascript for ${target}: ${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        const msg = (err || out).trim();
        // -1743: macOS Automation permission was declined for this app.
        if (/-1743|not allowed to send Apple events|Not authori[sz]ed to send Apple events/i.test(msg)) {
          const e = new Error(
            `Komposit is not allowed to control ${appLabel(target)}. ` +
              `Turn it on in System Settings > Privacy & Security > Automation.`,
          );
          e.code = "AUTOMATION_DENIED";
          return finish(reject, e);
        }
        return finish(reject, new Error(`${target} error (osascript exit ${code}):\n${msg}`));
      }
      finish(resolve, out.trim());
    });
  });
}

// Bring an app to the front (best-effort; also launches it if not running).
export function activateApp(app) {
  const target = TARGET[app] || app;
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", `tell ${target} to activate`], { stdio: "ignore" });
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 90000);
    child.on("close", () => { clearTimeout(t); resolve(); });
    child.on("error", () => { clearTimeout(t); resolve(); });
  });
}

// Where After Effects' "Allow Scripts to Write Files" setting lives here.
export const aeScriptSettings = "Settings > Scripting & Expressions";

// ---------- processes ----------

// Process-name fragments to detect a running app (pgrep -f), for the workspace.
const APP_PROC = {
  illustrator: "Adobe Illustrator",
  photoshop: "Adobe Photoshop",
  aftereffects: "Adobe After Effects",
};

// Which apps are running right now (uncached; desktop.mjs caches).
export async function runningApps() {
  const out = {};
  await Promise.all(
    Object.entries(APP_PROC).map(async ([id, proc]) => {
      const r = await run("pgrep", ["-f", proc], 3000);
      out[id] = r.ok && r.stdout.trim().length > 0;
    }),
  );
  return out;
}

// Stricter process names, to tell whether an app is still alive after a
// failure (a crash), for the incident log.
const PROC = {
  illustrator: "Adobe Illustrator.app/Contents/MacOS",
  photoshop: "Adobe Photoshop.*.app/Contents/MacOS",
  aftereffects: "MacOS/After Effects$",
};

export function isAppRunning(app) {
  const pat = PROC[app];
  if (!pat) return Promise.resolve(true);
  return new Promise((r) => execFile("pgrep", ["-f", pat], (err, out) => r(!err && !!String(out).trim())));
}

// The main process id of an app, or null.
export function appPid(app) {
  const pat = PROC[app];
  if (!pat) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("pgrep", ["-f", pat], { timeout: 3000 }, (err, out) => resolve(err ? null : Number(String(out).trim().split("\n")[0]) || null));
  });
}

// How long a process has been running, in seconds (0 if unknown).
export function processUptime(pid) {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "etime=", "-p", String(pid)], { timeout: 3000 }, (err, out) => {
      if (err) return resolve(0);
      resolve(parseEtime(out));
    });
  });
}

// ps etime: [[dd-]hh:]mm:ss -> seconds.
export function parseEtime(out) {
  const s = String(out).trim();
  const [dayPart, rest] = s.includes("-") ? s.split("-") : [0, s];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(dayPart) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// ---------- windows (dialog notice) ----------
//
// The app's windows through CoreGraphics (JXA): about 0.1 s, no extra macOS
// permission. Window layer 8 is where modal panels sit; 0 is normal windows.

const OWNER = { illustrator: "Adobe Illustrator", photoshop: "Adobe Photoshop", aftereffects: "After Effects" };

const JXA = `ObjC.import('CoreGraphics'); ObjC.import('Foundation');
function run(argv){
  var arr = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0))) || [], out = [];
  for (var i=0;i<arr.length;i++){ var w = arr[i];
    if (String(w.kCGWindowOwnerName || '').indexOf(argv[0]) !== 0) continue;
    var b = w.kCGWindowBounds || {};
    out.push(w.kCGWindowNumber + ',' + Math.round(b.Width || 0) + ',' + Math.round(b.Height || 0) + ',' + (w.kCGWindowLayer || 0)); }
  return out.join(';');
}`;

let scriptPath = null;
function script() {
  if (scriptPath && existsSync(scriptPath)) return scriptPath;
  scriptPath = join(scratchDir(), "windows.js");
  writeFileSync(scriptPath, JXA);
  return scriptPath;
}

// Map of window id -> { w, h, layer } for the app's windows, or null if unreadable.
export function appWindows(app) {
  const owner = OWNER[app];
  if (!owner) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("osascript", ["-l", "JavaScript", script(), owner], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = new Map();
      for (const part of String(stdout).trim().split(";")) {
        const [id, w, h, layer] = part.split(",").map(Number);
        if (id) m.set(id, { w, h, layer: layer || 0 });
      }
      resolve(m);
    });
  });
}

// ---------- installed apps, launching, permissions ----------

// macOS bundle ids, for Automation permission checks and launching.
export const BUNDLE_IDS = {
  illustrator: "com.adobe.illustrator",
  photoshop: "com.adobe.Photoshop",
  aftereffects: "com.adobe.AfterEffects.application",
};

// Where each app is installed (Spotlight by bundle id), or null.
export async function installedApps() {
  const out = {};
  await Promise.all(
    Object.entries(BUNDLE_IDS).map(async ([id, bid]) => {
      const r = await run("mdfind", [`kMDItemCFBundleIdentifier == '${bid}'`], 8000);
      const paths = r.stdout.split("\n").filter((p) => p.endsWith(".app") && !p.includes("/Trash/"));
      out[id] = paths[0] || null;
    }),
  );
  return out;
}

// Open an Adobe app (launches it; Komposit can then ask for permission).
export async function launchApp(app) {
  const bid = BUNDLE_IDS[app];
  if (!bid) return { ok: false };
  const r = await run("open", ["-b", bid], 15000);
  return { ok: r.ok };
}

// The native helper ships inside Komposit.app; in a repo checkout it is built
// to packaging/build. Without it we can't read the permission state silently.
export function helperPath() {
  const candidates = [
    process.env.KOMPOSIT_HELPER,
    join(dirname(process.execPath), "komposit-helper"),
    join(ROOT, "packaging", "build", "komposit-helper"),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

const AE_STATUS = { 0: "allowed", "-1743": "denied", "-1744": "ask", "-600": "not-running" };

// macOS Automation permission for controlling one app: allowed, denied, ask,
// not-running or unknown. With ask, macOS shows its consent dialog (attributed
// to Komposit) and this waits for the answer.
export async function automationState(app, { ask = false } = {}) {
  const helper = helperPath();
  if (!helper) return "unknown";
  // Asking shows the macOS dialog and waits for the person to answer.
  const r = await run(helper, ["automation", BUNDLE_IDS[app], ...(ask ? ["--ask"] : [])], ask ? 120000 : 8000);
  try {
    const { status } = JSON.parse(r.stdout);
    return AE_STATUS[String(status)] || "unknown";
  } catch {
    return "unknown";
  }
}

// Windows remembers a successful test script; macOS reads the real permission.
export async function noteConnected() {}

const PANES = {
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
  files: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders",
};

export async function openSettingsPane(kind) {
  const url = PANES[kind];
  if (!url) return { ok: false };
  const r = await run("open", [url]);
  return { ok: r.ok };
}

// Open a file in the app that owns it.
export async function openPath(path) {
  const r = await run("open", [path], 8000);
  return r.ok;
}

// A QuickLook thumbnail PNG (400 px) of `path`, written into `outDir`;
// returns the PNG bytes or null. qlmanage writes "<basename>.png" there.
export async function thumbnail(path, outDir, cachedPath) {
  await run("qlmanage", ["-t", "-s", "400", "-o", outDir, path], 20000);
  const generated = join(outDir, basename(path) + ".png");
  try {
    await rename(generated, cachedPath);
    return await readFile(cachedPath);
  } catch {
    return null;
  }
}

// ---------- the person's shell (Claude Code) ----------

// An app opened from Finder starts with a bare PATH (/usr/bin:/bin:/usr/sbin:
// /sbin), so ask the person's login shell for its PATH.
export async function loginPath(runFn) {
  const shell = process.env.SHELL || "/bin/zsh";
  const r = await runFn(shell, ["-ilc", 'printf "__KP__%s__KP__" "$PATH"'], { timeout: 6000 });
  const m = /__KP__([\s\S]*?)__KP__/.exec(r.stdout);
  return m ? m[1] : "";
}

// Usual places a `claude` binary is installed, after the PATH.
export function extraBinDirs() {
  return [
    join(HOME, ".local", "bin"),
    join(HOME, ".claude", "local"),
    join(HOME, ".npm-global", "bin"),
    join(HOME, ".bun", "bin"),
    join(HOME, ".volta", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

// The tail of every PATH Komposit builds for child processes.
export const systemPathDirs = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

// File names a `claude` executable can have, in order of preference.
export const claudeNames = ["claude"];

// File names a `codex` executable can have (npm's is a Node launcher script).
export const codexNames = ["codex"];

// ---------- child processes ----------

// Options for a child that Stop must be able to kill with everything it
// started: its own process group.
export const groupSpawnOptions = { detached: true };

// Kill a child and its whole process group.
export function killTree(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

// Started by Komposit.app: if the app goes away without stopping us (force
// quit, crash), we're re-parented to launchd. onOrphan() then shuts down.
export function watchParent(onOrphan) {
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) onOrphan();
  }, 2000).unref();
}
