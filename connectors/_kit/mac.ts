// macOS: how the scripting connectors reach Illustrator, Photoshop and After Effects.
//
// AppleScript (`do javascript` / After Effects' `DoScript`) for scripts; JXA for window
// lists and dialogs; pgrep, ps and mdfind for processes and installed apps. The Windows
// counterpart is win.ts; both build the same ScriptTransport. These calls move into the
// native helper later (architecture 3.9); the interface stays.
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { aeScriptWritesPref } from "./aeprefs.ts";
import { rmQuiet, createScratch } from "./scratch.ts";
import type { Scratch } from "./scratch.ts";
import { KitError } from "./transport.ts";
import type { AutomationState, DialogsRead, RunJsxOptions, ScriptTransport, WindowMap } from "./transport.ts";

interface RunOut {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], timeout = 8000): Promise<RunOut> {
  return new Promise((res) => {
    execFile(cmd, args, { timeout, encoding: "utf8" }, (err, stdout, stderr) => res({ ok: !err, stdout: stdout || "", stderr: stderr || "" }));
  });
}

// ---------- the ExtendScript transport (AppleScript) ----------

// AppleScript targets. Illustrator's app name has no year in it; Photoshop goes by bundle
// id. After Effects is looked up every time (aeTarget below).
const TARGET: Record<string, string> = {
  illustrator: 'application "Adobe Illustrator"',
  photoshop: 'application id "com.adobe.Photoshop"',
};

// After Effects' app name carries its year ("Adobe After Effects 2025"), and a script sent
// to a name that isn't installed never arrives. So no version is assumed:
//  1. AE_APP, if set (an unusual install name);
//  2. else the After Effects that's running, by its own app name, so a script goes to the
//     version the person has open, even with several installed;
//  3. else the bundle id every version shares. macOS picks the newest one installed, which
//     is also the one `activate` starts.
export const AE_BUNDLE_ID = "com.adobe.AfterEffects.application";

// macOS bundle ids, for Automation permission checks, detection and launching.
export const BUNDLE_IDS: Record<string, string> = {
  illustrator: "com.adobe.illustrator",
  photoshop: "com.adobe.Photoshop",
  aftereffects: AE_BUNDLE_ID,
};

// The app names of the running After Effects in `ps -axo comm=` output, newest first:
// ".../Adobe After Effects 2025.app/Contents/MacOS/After Effects" -> "Adobe After Effects
// 2025". The Render Engine and AE's helpers don't count.
export function parseRunningAe(psOut: string): string[] {
  const names = new Set<string>();
  for (const line of String(psOut).split("\n")) {
    const m = /\/([^/]+)\.app\/Contents\/MacOS\/After Effects$/.exec(line.trim());
    if (m) names.add(m[1]);
  }
  return [...names].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

// The AppleScript target for After Effects, from AE_APP and the running names.
export function targetForAe({ envName, running = [] }: { envName?: string; running?: string[] } = {}): string {
  const name = envName || running[0];
  return name ? `application ${JSON.stringify(name)}` : `application id ${JSON.stringify(AE_BUNDLE_ID)}`;
}

// "application \"Adobe Illustrator\"" or "application id \"com.adobe.Photoshop\"" -> a name.
export function appLabel(target: string): string {
  const m = String(target).match(/"([^"]+)"/);
  const s = m ? m[1] : String(target);
  if (/photoshop/i.test(s)) return "Photoshop";
  if (/illustrator/i.test(s)) return "Illustrator";
  if (/after ?effects/i.test(s)) return "After Effects"; // also the bundle id
  if (/premiere/i.test(s)) return "Premiere Pro";
  return s;
}

/** What a failed osascript run means, as an Error with a plain message and a code. */
export function osascriptFailure(target: string, exitCode: number | null, output: string): KitError {
  const msg = String(output || "").trim();
  const label = appLabel(target);
  // -1743: macOS Automation permission was declined for this app.
  if (/-1743|not allowed to send Apple events|Not authori[sz]ed to send Apple events/i.test(msg)) {
    return new KitError(`Komposit is not allowed to control ${label}. Turn it on in System Settings > Privacy & Security > Automation.`, "AUTOMATION_DENIED");
  }
  // -1728 "Can't get application": macOS restarted the screen (WindowServer) and this
  // process belongs to the desktop session from before; it can't reach apps launched
  // since. Only restarting Komposit fixes it.
  if (/Can.t get application|\(-1728\)/i.test(msg) && /application id|application "/i.test(msg)) {
    return new KitError(
      `Komposit lost its line to ${label}. This happens after macOS restarts the screen (everything closes and reopens). Quit and reopen Komposit, then try again.`,
      "SESSION_LOST",
    );
  }
  // Kept close to 1.0's text: the incident log classifies on it (-1712 timeout, -609 crash).
  return new KitError(`${target} error (osascript exit ${exitCode}):\n${msg}`, "APP_ERROR");
}

export interface MacTransportOptions {
  scratch?: Scratch;
  /** The native helper that reads the Automation permission silently. Default: KOMPOSIT_HELPER. */
  helperPath?: string | null;
  /** AE_APP: an unusual After Effects install name. Default: process.env.AE_APP. */
  aeAppName?: string;
  /** Where After Effects keeps its prefs. Default: ~/Library/Preferences/Adobe/After Effects. */
  aePrefsDir?: string;
}

// Whether an app is alive: its own program, by path (`ps -axo pid=,comm=`), never a helper in
// its bundle. Photoshop's crash reporter (Contents/Frameworks/.../Adobe Crash Processor.app)
// stays after Photoshop quits; the old `pgrep -f "Adobe Photoshop.*.app/Contents/MacOS"` read
// it as Photoshop, and the next script launched Photoshop (live test, Nov 16). Premiere's own
// MacOS folder holds helpers too (CEPHtmlEngine, which runs Komposit's panel;
// dynamiclinkmanager; PProHeadless): only "…/Adobe Premiere Pro 2026.app/Contents/MacOS/Adobe
// Premiere Pro 2026" counts.
const MAIN_PROGRAM: Record<string, RegExp> = {
  illustrator: /\/Adobe Illustrator[^/]*\.app\/Contents\/MacOS\/Adobe Illustrator[^/]*$/,
  photoshop: /\/Adobe Photoshop[^/]*\.app\/Contents\/MacOS\/Adobe Photoshop[^/]*$/,
  aftereffects: /\/[^/]+\.app\/Contents\/MacOS\/After Effects$/,
  premiere: /\/Adobe Premiere Pro[^/]*\.app\/Contents\/MacOS\/Adobe Premiere Pro[^/]*$/,
};

/** The pids of an app's own program in `ps -axo pid=,comm=` output (none: it isn't running). */
export function appPids(psOut: string, app: string): number[] {
  const re = MAIN_PROGRAM[app];
  if (!re) return [];
  const out: number[] = [];
  for (const line of String(psOut).split("\n")) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (m && re.test(m[2]!)) out.push(Number(m[1]));
  }
  return out;
}

// Premiere's bundle id carries its version (com.adobe.PremierePro.26), so Spotlight is asked
// for any of them.
const BUNDLE_QUERY: Record<string, string> = { premiere: "com.adobe.PremierePro.*" };

// The app's windows through CoreGraphics (JXA): about 0.1 s, no extra macOS permission.
// Window layer 8 is where modal panels sit; 0 is normal windows. A window's title comes too
// when macOS gives it (only with the Screen Recording permission): it tells After Effects'
// own "Executing Script ..." window from a dialog.
const OWNER: Record<string, string> = { illustrator: "Adobe Illustrator", photoshop: "Adobe Photoshop", aftereffects: "After Effects", premiere: "Adobe Premiere Pro" };

const WINDOWS_JXA = `ObjC.import('CoreGraphics'); ObjC.import('Foundation');
function run(argv){
  var arr = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0))) || [], out = [];
  for (var i=0;i<arr.length;i++){ var w = arr[i];
    if (String(w.kCGWindowOwnerName || '').indexOf(argv[0]) !== 0) continue;
    var b = w.kCGWindowBounds || {};
    out.push(w.kCGWindowNumber + ',' + Math.round(b.Width || 0) + ',' + Math.round(b.Height || 0) + ',' + (w.kCGWindowLayer || 0) + ',' + encodeURIComponent(String(w.kCGWindowName || ''))); }
  return out.join(';');
}`;

/** "id,w,h,layer[,title];..." from the window script -> the map (the title URI-encoded). */
export function parseWindowList(out: string): WindowMap {
  const m: WindowMap = new Map();
  for (const part of String(out).trim().split(";")) {
    const [rawId, rawW, rawH, rawLayer, rawTitle] = part.split(",");
    const id = Number(rawId);
    if (!id) continue;
    let title = "";
    try { title = rawTitle ? decodeURIComponent(rawTitle) : ""; } catch { title = ""; }
    m.set(id, { w: Number(rawW), h: Number(rawH), layer: Number(rawLayer) || 0, ...(title ? { title } : {}) });
  }
  return m;
}

// ---------- dialogs: what they say, and answering them ----------
//
// Through Accessibility (System Events, JXA): the app's dialogs and sheets, with their
// title, their text and the names of their buttons, and pressing a button by name or a
// key (Return, Escape; only to an app already in front, never brought forward for it). This
// needs the Accessibility permission for Komposit; without it
// `dialogs` says { denied: true } and the caller falls back to "the app is showing a
// dialog". Some Adobe dialogs are drawn by the app itself and expose nothing: those come
// back with no text, and a picture of the window (dialogShot) tells what they say.
const AX_JXA = `
function txt(v) { try { return v == null ? '' : String(v); } catch (e) { return ''; } }
function boxes(p) {
  var out = [], wins = [];
  try { wins = p.windows(); } catch (e) {}
  for (var w = 0; w < wins.length; w++) {
    var win = wins[w], sub = '', sheets = [];
    try { sheets = win.sheets(); } catch (e) {}
    for (var s = 0; s < sheets.length; s++) out.push({ el: sheets[s], kind: 'sheet' });
    try { sub = win.subrole(); } catch (e) {}
    if (sub === 'AXDialog' || sub === 'AXSystemDialog') out.push({ el: win, kind: 'dialog' });
  }
  return out;
}
function buttonName(c) { var n = ''; try { n = txt(c.title()); } catch (e) {} if (!n) { try { n = txt(c.name()); } catch (e) {} } if (!n) { try { n = txt(c.description()); } catch (e) {} } return n; }
function parts(el) {
  var d = { title: '', text: [], buttons: [], fields: 0 }, all = [];
  try { d.title = txt(el.title()) || txt(el.name()); } catch (e) {}
  try { all = el.entireContents(); } catch (e) {}
  for (var i = 0; i < all.length && i < 160; i++) {
    var c = all[i], role = '';
    try { role = c.role(); } catch (e) { continue; }
    if (role === 'AXStaticText') { var v = ''; try { v = txt(c.value()) || txt(c.name()); } catch (e) {} v = v.trim(); if (v && d.text.indexOf(v) < 0 && d.text.length < 12) d.text.push(v.slice(0, 600)); }
    else if (role === 'AXButton') { var sub = ''; try { sub = txt(c.subrole()); } catch (e) {} if (/^AX(Close|Minimize|Zoom|FullScreen)Button$/.test(sub)) continue; var n = buttonName(c).trim(); if (n && d.buttons.indexOf(n) < 0 && d.buttons.length < 8) d.buttons.push(n.slice(0, 60)); }
    else if (role === 'AXTextField' || role === 'AXTextArea' || role === 'AXComboBox') d.fields++;
  }
  return d;
}
function run(argv) {
  var se = Application('System Events'), list = [];
  try { list = se.processes.whose({ name: { _beginsWith: argv[1] } })(); } catch (e) { return JSON.stringify({ denied: /-25211|-1719|assistive/i.test(String(e)), error: String(e).slice(0, 200) }); }
  if (!list.length) return JSON.stringify({ dialogs: [] });
  var p = list[0], found;
  try { found = boxes(p); } catch (e) { return JSON.stringify({ denied: /-25211|-1719|assistive/i.test(String(e)), error: String(e).slice(0, 200) }); }
  if (argv[0] === 'read') {
    var out = [];
    for (var i = 0; i < found.length && i < 4; i++) { var d = parts(found[i].el); d.kind = found[i].kind; out.push(d); }
    return JSON.stringify({ dialogs: out });
  }
  if (argv[0] === 'press') {
    var want = String(argv[2] || '').toLowerCase();
    for (var j = 0; j < found.length; j++) {
      var all = []; try { all = found[j].el.entireContents(); } catch (e) {}
      for (var k = 0; k < all.length && k < 160; k++) {
        var c = all[k], role = ''; try { role = c.role(); } catch (e) { continue; }
        if (role === 'AXButton' && buttonName(c).trim().toLowerCase() === want) { c.click(); return JSON.stringify({ ok: true }); }
      }
    }
    return JSON.stringify({ ok: false, reason: 'no such button' });
  }
  if (argv[0] === 'key') {
    var front = false; try { front = p.frontmost(); } catch (e) {}
    if (!front) return JSON.stringify({ ok: false, reason: 'not in front' });
    se.keyCode(argv[2] === 'escape' ? 53 : 36);
    return JSON.stringify({ ok: true });
  }
  return JSON.stringify({ ok: false });
}`;

// ps etime: [[dd-]hh:]mm:ss -> seconds.
export function parseEtime(out: string): number {
  const s = String(out).trim();
  const [dayPart, rest] = s.includes("-") ? s.split("-") : ["0", s];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(dayPart) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

const AUTOMATION_STATUS: Record<string, AutomationState> = { "0": "allowed", "-1743": "denied", "-1744": "ask", "-600": "not-running" };

export function createMacTransport(opts: MacTransportOptions = {}): ScriptTransport {
  const scratch = opts.scratch || createScratch();
  const aeEnvName = opts.aeAppName ?? process.env.AE_APP;
  const helper = opts.helperPath === undefined ? process.env.KOMPOSIT_HELPER || null : opts.helperPath;
  const aePrefsDir = opts.aePrefsDir || join(homedir(), "Library", "Preferences", "Adobe", "After Effects");
  let aeSeen: string | null = null; // the After Effects last seen running

  async function aeTarget(): Promise<string> {
    if (!aeEnvName) {
      const r = await run("ps", ["-axo", "comm="], 3000);
      aeSeen = (r.ok && parseRunningAe(r.stdout)[0]) || null;
    }
    return targetForAe({ envName: aeEnvName, running: aeSeen ? [aeSeen] : [] });
  }

  // The AppleScript target for an app id; an AppleScript target string passes through.
  async function resolveTarget(app: string): Promise<string> {
    return app === "aftereffects" ? aeTarget() : TARGET[app] || app;
  }

  // A script file written once per scratch folder (the JXA helpers).
  const scripts = new Map<string, string>();
  function scriptFile(name: string, src: string): string {
    const known = scripts.get(name);
    if (known && existsSync(known)) return known;
    const p = join(scratch.dir(), name);
    writeFileSync(p, src);
    scripts.set(name, p);
    return p;
  }

  async function ax(args: string[], timeout = 9000): Promise<DialogsRead & { ok?: boolean; reason?: string }> {
    const r = await run("osascript", ["-l", "JavaScript", scriptFile("dialogs.js", AX_JXA), ...args], timeout);
    if (!r.ok) return { denied: /-25211|-1719|assistive/i.test(r.stderr), error: r.stderr.trim().slice(0, 200) || "no answer" };
    try {
      return JSON.parse(r.stdout.trim());
    } catch {
      return { error: "unreadable" };
    }
  }

  return {
    platform: "mac",
    aeScriptSettings: "Settings > Scripting & Expressions",

    // Run a jsx source string inside the app via AppleScript, without blocking the core
    // while the app works. `via` is "stdout" (`do javascript` returns the script's last
    // expression) or "file" (After Effects' `DoScript` returns nothing; the script writes
    // its result to a file). Resolves with stdout; rejects on error, timeout or abort.
    async runJsx(app: string, jsxSource: string, { via = "stdout", timeoutMs = 120000, signal }: RunJsxOptions = {}) {
      const target = await resolveTarget(app);
      const verb = via === "file" ? "DoScript" : "do javascript";
      const jsxPath = scratch.name("exec", "jsx");
      const scptPath = scratch.name("exec", "applescript");
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

      return new Promise<string>((resolve, reject) => {
        const child = spawn("osascript", [scptPath], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        let settled = false;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (c: string) => (out += c));
        child.stderr.on("data", (c: string) => (err += c));

        const finish = (fn: (v: never) => void, v: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          rmQuiet(jsxPath);
          rmQuiet(scptPath);
          fn(v as never);
        };
        const timer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
          finish(
            reject,
            new KitError(`${appLabel(target)} didn't answer in time. If it's showing a dialog, close it. The step may still finish inside the app, so check before retrying.`, "TIMEOUT"),
          );
        }, timeoutMs);
        const onAbort = () => {
          try { child.kill("SIGKILL"); } catch {}
          finish(reject, new KitError("stopped", "STOPPED"));
        };
        if (signal) {
          if (signal.aborted) return onAbort();
          signal.addEventListener("abort", onAbort, { once: true });
        }
        child.on("error", (e) => finish(reject, new KitError(`Komposit couldn't start the macOS script runner for ${appLabel(target)}: ${e.message}`, "SPAWN")));
        child.on("close", (code) => {
          if (code !== 0) return finish(reject, osascriptFailure(target, code, err || out));
          finish(resolve, out.trim());
        });
      });
    },

    async isAppRunning(app) {
      if (!MAIN_PROGRAM[app]) return true;
      return appPids((await run("ps", ["-axo", "pid=,comm="], 3000)).stdout, app).length > 0;
    },

    async appPid(app) {
      if (!MAIN_PROGRAM[app]) return null;
      return appPids((await run("ps", ["-axo", "pid=,comm="], 3000)).stdout, app)[0] ?? null;
    },

    processUptime(pid) {
      return new Promise((resolve) => {
        execFile("ps", ["-o", "etime=", "-p", String(pid)], { timeout: 3000 }, (err, out) => resolve(err ? 0 : parseEtime(String(out))));
      });
    },

    appWindows(app) {
      const owner = OWNER[app];
      if (!owner) return Promise.resolve(null);
      return new Promise((resolve) => {
        execFile("osascript", ["-l", "JavaScript", scriptFile("windows.js", WINDOWS_JXA), owner], { timeout: 4000 }, (err, stdout) =>
          resolve(err ? null : parseWindowList(String(stdout))),
        );
      });
    },

    async dialogs(app) {
      return OWNER[app] ? ax(["read", OWNER[app]]) : { dialogs: [] };
    },

    async answerDialog(app, { button, key } = {}) {
      if (!OWNER[app]) return { ok: false };
      const r = button ? await ax(["press", OWNER[app], String(button)]) : key === "return" || key === "escape" ? await ax(["key", OWNER[app], key]) : { ok: false };
      return { ok: !!r.ok, reason: r.reason || r.error };
    },

    // A picture of one window, by its id from appWindows. Needs Screen Recording; without
    // it macOS gives an empty picture, which reads as "no picture".
    async dialogShot(id) {
      if (!Number.isInteger(id) || id <= 0) return null;
      const out = scratch.name("dialog", "png");
      const r = await run("screencapture", ["-x", "-o", `-l${id}`, out], 6000);
      try {
        if (!r.ok || !existsSync(out)) return null;
        const buf = readFileSync(out);
        return buf.length > 400 ? new Uint8Array(buf) : null;
      } catch {
        return null;
      } finally {
        rmQuiet(out);
      }
    },

    // Where the app is installed (Spotlight by bundle id), or null.
    async installedPath(app) {
      const bid = BUNDLE_IDS[app] || BUNDLE_QUERY[app];
      if (!bid) return null;
      const r = await run("mdfind", [`kMDItemCFBundleIdentifier == '${bid}'`], 8000);
      return r.stdout.split("\n").filter((p) => p.endsWith(".app") && !p.includes("/Trash/"))[0] || null;
    },

    // Bring an app to the front (best-effort; also launches it if not running).
    async activateApp(app) {
      const target = await resolveTarget(app);
      await new Promise<void>((resolve) => {
        const child = spawn("osascript", ["-e", `tell ${target} to activate`], { stdio: "ignore" });
        const t = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
          resolve();
        }, 90000);
        child.on("close", () => { clearTimeout(t); resolve(); });
        child.on("error", () => { clearTimeout(t); resolve(); });
      });
    },

    // macOS Automation permission for controlling one app: allowed, denied, ask,
    // not-running or unknown, read silently through the native helper. Never asks.
    async automationState(app) {
      const bid = BUNDLE_IDS[app];
      if (!helper || !bid || !existsSync(helper)) return "unknown";
      const r = await run(helper, ["automation", bid], 8000);
      try {
        const { status } = JSON.parse(r.stdout);
        return AUTOMATION_STATUS[String(status)] || "unknown";
      } catch {
        return "unknown";
      }
    },

    aeScriptWrites() {
      return aeScriptWritesPref(aePrefsDir);
    },
  };
}
