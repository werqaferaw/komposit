// The kit's parts that need no app: the envelope (run for real in a Node vm, since
// ExtendScript is ES3), the guard's line numbers, export naming, the incident log, error
// wording, the dialog watch, and the Mac and Windows transports' pure helpers. Ported from
// 1.0's tools.test.mjs, mac.test.mjs, win.test.mjs and incidents.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { parseAePref, aeScriptWritesPref } from "./aeprefs.ts";
import { agentMayPress, createAeReady, createDialogWatcher, dialogText, hasModal, layersMeanDialog, newDialogs, readDialog } from "./dialogwatch.ts";
import { codeLineBase, parseEnvelope, wrap } from "./envelope.ts";
import { scriptHint, withHint } from "./hints.ts";
import { createFakeTransport, fakeFileClass } from "./fake.ts";
import { isInside, newOutputPath, outputFolder, safeBase, uniquePath } from "./files.ts";
import { parseGuide, serveGuide } from "./guide.ts";
import { appKey, classify, createIncidentLog } from "./incidents.ts";
import type { Incident } from "./incidents.ts";
import * as mac from "./mac.ts";
import { codeLine, plainError } from "./runner.ts";
import { KitError } from "./transport.ts";
import type { WindowMap } from "./transport.ts";
import * as win from "./win.ts";

const run = (src: string, globals: Record<string, unknown> = {}) => vm.runInNewContext(src, globals);

test("envelope: the value, logs and errors come back as JSON from an ES3 script", () => {
  const env = parseEnvelope(run(wrap(`log('hi'); log(2); return { a: 1, s: "q\\"uote\\n\\ttab \\u0001", arr: [1, null, true], nan: 0/0 };`)), "Illustrator");
  assert.equal(env.ok, true);
  assert.deepEqual(env.logs, ["hi", "2"]);
  assert.deepEqual(env.data, { a: 1, s: 'q"uote\n\ttab \u0001', arr: [1, null, true], nan: null });

  const bad = parseEnvelope(run(wrap(`var x = null; return x.y;`)), "Illustrator");
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /null|undefined/);

  // A value that can't be encoded says so, instead of breaking the envelope.
  const odd = parseEnvelope(run(wrap(`return { get boom(){ throw new Error('nope'); } };`)), "Illustrator");
  assert.equal(odd.ok, false);
  assert.match(String(odd.error), /^Result not serializable/);
});

test("envelope: viaEval catches a syntax error inside the envelope (After Effects, Windows)", () => {
  const env = parseEnvelope(run(wrap(`return (1 + ;`, { viaEval: true })), "After Effects");
  assert.equal(env.ok, false);
  assert.ok(env.error);
  // Without eval the whole script fails to compile: the app reports it, not the envelope.
  assert.throws(() => run(wrap(`return (1 + ;`)));
});

test("envelope: the result file handoff writes JSON to the named file", () => {
  const dir = mkdtempSync(join(tmpdir(), "kp-env-"));
  try {
    const out = join(dir, "result.json");
    run(wrap(`return [1, 'two'];`, { write: out, viaEval: true }), { File: fakeFileClass() });
    const env = parseEnvelope(readFileSync(out, "utf8"), "After Effects");
    assert.deepEqual(env, { ok: true, error: null, logs: [], data: [1, "two"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("envelope: the guard keeps the code's line numbers and always runs `after`", () => {
  const plain = wrap("line1;\nline2;", { viaEval: true });
  const guarded = wrap("line1;\nline2;", { viaEval: true, guard: { before: "var a = 1;\nvar b = 2;", setup: "var c = 3;", after: "x();" } });
  const evalSrc = (s: string) => JSON.parse(/eval\(("(?:[^"\\]|\\.)*")\)/.exec(s)![1]) as string;
  const lineOf = (src: string, needle: string) => src.split("\n").findIndex((l) => l.includes(needle));
  assert.equal(lineOf(evalSrc(guarded), "line2"), lineOf(evalSrc(plain), "line2"), "same line in the eval'd source");
  const calls: string[] = [];
  const g = { before: "calls.push('before');", setup: "calls.push('setup');", after: "calls.push('after');" };
  const env = parseEnvelope(run(wrap("calls.push('code'); throw new Error('bad');", { guard: g }), { calls }), "Illustrator");
  assert.equal(env.ok, false);
  assert.equal(env.error, "bad");
  assert.deepEqual(calls, ["before", "setup", "code", "after"]);
});

test("envelope: unreadable output is a plain sentence, with the raw text kept in the logs", () => {
  const env = parseEnvelope("Error: something odd", "Photoshop");
  assert.equal(env.ok, false);
  assert.equal(env.error, "Photoshop sent back something Komposit couldn't read.");
  assert.deepEqual(env.logs, ["Error: something odd"]);
  assert.equal(parseEnvelope("", "Photoshop").error, "Photoshop sent nothing back.");
  assert.equal(parseEnvelope('\uFEFF{"ok":true,"error":null,"logs":[],"data":3}', "x").data, 3);
});

test("file naming: never overwrites, safe names", () => {
  const dir = mkdtempSync(join(tmpdir(), "kp-"));
  try {
    const a = uniquePath(dir, "logo", "pdf");
    assert.equal(a, join(dir, "logo.pdf"));
    writeFileSync(a, "x");
    assert.equal(uniquePath(dir, "logo", "pdf"), join(dir, "logo 2.pdf"));
    writeFileSync(join(dir, "logo 2.pdf"), "x");
    assert.equal(uniquePath(dir, "logo", "pdf"), join(dir, "logo 3.pdf"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(safeBase("../../etc/passwd"), "etc-passwd");
  assert.equal(safeBase("Poster final.pdf"), "Poster final");
  assert.equal(safeBase(""), "komposit-export");
  assert.equal(safeBase(null, "komposit-frame"), "komposit-frame");
});

test("output folder: inside the home folder or a project folder, default Komposit Exports", () => {
  const home = mkdtempSync(join(tmpdir(), "kp-home-"));
  const project = mkdtempSync(join(tmpdir(), "kp-proj-"));
  try {
    assert.throws(() => outputFolder("/etc", { home }), /inside your home folder or a project's folder/);
    assert.throws(() => outputFolder("~/../../etc", { home }), /inside your home folder/);
    assert.equal(outputFolder(undefined, { home }), join(home, "Komposit Exports"));
    assert.equal(outputFolder("~/Work", { home }), join(home, "Work"));
    assert.equal(outputFolder(project, { home, allowedRoots: () => [project] }), project);
    const p = newOutputPath({ name: "poster.png", ext: "png" }, { home });
    assert.equal(p, join(home, "Komposit Exports", "poster.png"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("isInside: Windows is case-insensitive, either slash, no ../ escapes", () => {
  const home = "C:\\Users\\ana";
  assert.ok(isInside(home, "C:\\Users\\ana\\Desktop\\poster.ai", "win"));
  assert.ok(isInside(home, "c:\\users\\ANA\\desktop", "win"));
  assert.ok(isInside(home, "C:/Users/ana/Documents/x.psd", "win"));
  assert.ok(isInside("C:\\Users\\ana\\", "C:\\Users\\ana\\a", "win"));
  assert.ok(!isInside(home, "C:\\Users\\ana\\..\\bob\\x", "win"));
  assert.ok(!isInside(home, "C:\\Users\\anabel\\x", "win"), "a sibling with the same prefix");
  assert.ok(!isInside(home, "D:\\Users\\ana\\x", "win"));
  assert.ok(!isInside(home, "", "win"));
  assert.ok(isInside("/Users/ana", "/Users/ana/x", "mac"));
  assert.ok(!isInside("/Users/ana", "/Users/anabel/x", "mac"));
  assert.ok(!isInside("/Users/ana", "/Users/ANA/x", "mac"), "case-sensitive on a Mac");
});

test("incidents: classifies transport failures", () => {
  assert.equal(classify("Adobe Illustrator didn't answer in time. If it's showing a dialog…"), "timeout");
  assert.equal(classify("execution error: Adobe Illustrator got an error: AppleEvent timed out. (-1712)"), "timeout");
  assert.equal(classify("Connection is invalid. (-609)"), "crash");
  assert.equal(classify("Error 1302: No such element"), "app-error");
  assert.equal(appKey('application "Adobe Illustrator"'), "illustrator");
  assert.equal(appKey('application id "com.adobe.Photoshop"'), "photoshop");
  assert.equal(appKey("Adobe After Effects 2026"), "aftereffects");
});

test("incidents: recorded through the callback with the script; stops and declined permissions skipped", async () => {
  const rows: Incident[] = [];
  const log = createIncidentLog((i) => rows.push(i), async () => true);
  log.record({ app: 'application "Adobe Illustrator"', kind: "script-error", message: "Target layer cannot be modified (line 3)", script: "var d = app.activeDocument;" });
  await log.failure('application "Adobe Illustrator"', new Error("Connection is invalid. (-609)"), "app.activeDocument.close()");
  await log.failure("illustrator", new Error("stopped"), "x");
  await log.failure("illustrator", new KitError("Komposit is not allowed to control Illustrator.", "AUTOMATION_DENIED"), "x");
  assert.deepEqual(rows.map((r) => [r.app, r.kind]), [["illustrator", "script-error"], ["illustrator", "crash"]]);
  assert.match(rows[0].script || "", /activeDocument/);
  // An app-error while the app has gone is a crash.
  const gone: Incident[] = [];
  await createIncidentLog((i) => gone.push(i), async () => false).failure("photoshop", new Error("something odd"), "s");
  assert.equal(gone[0].kind, "crash");
  // No callback: nothing happens, nothing throws. A throwing callback doesn't break a turn.
  await createIncidentLog(undefined, async () => true).failure("photoshop", new Error("x"));
  createIncidentLog(() => { throw new Error("disk full"); }, async () => true).record({ app: "photoshop", kind: "timeout" });
});

test("errors: transport failures read as plain sentences, without codes", () => {
  const denied = mac.osascriptFailure('application "Adobe Illustrator"', 1, "execution error: Not authorized to send Apple events to Adobe Illustrator. (-1743)");
  assert.equal(denied.code, "AUTOMATION_DENIED");
  assert.equal(denied.message, "Komposit is not allowed to control Illustrator. Turn it on in System Settings > Privacy & Security > Automation.");
  assert.equal(plainError("illustrator", denied).message, denied.message);
  const lost = mac.osascriptFailure('application id "com.adobe.Photoshop"', 1, `execution error: Can't get application id "com.adobe.Photoshop". (-1728)`);
  assert.equal(lost.code, "SESSION_LOST");
  assert.match(lost.message, /^Komposit lost its line to Photoshop\..*Quit and reopen Komposit/);

  const generic = mac.osascriptFailure('application "Adobe Illustrator"', 1, "0:120: execution error: Adobe Illustrator got an error: The document is locked (-2700)");
  const p = plainError("illustrator", generic);
  assert.equal(p.message, "Illustrator couldn't run the script: The document is locked.");
  assert.doesNotMatch(p.message, /-\d{3,}|osascript|exit/);
  assert.equal(plainError("illustrator", mac.osascriptFailure('application "Adobe Illustrator"', 1, "AppleEvent timed out. (-1712)")).code, "TIMEOUT");
  const crash = plainError("photoshop", mac.osascriptFailure('application id "com.adobe.Photoshop"', 1, "Connection is invalid. (-609)"));
  assert.equal(crash.message, "Photoshop stopped answering. It may have crashed or quit; open it again, then try again.");
  assert.match(plainError("photoshop", new KitError("stopped", "STOPPED")).message, /^Stopped before Photoshop answered/);
  const com = plainError("illustrator", win.comError("illustrator", { code: "SCRIPT", json: { error: "Error 21: undefined is not an object" } }));
  assert.equal(com.message, "Illustrator couldn't run the script: Error 21: undefined is not an object.");
});

test("Mac: After Effects is the version that's open, not a fixed year", () => {
  const AE = (year: number, base = "/Applications") => `${base}/Adobe After Effects ${year}/Adobe After Effects ${year}.app/Contents/MacOS/After Effects`;
  const ps = [
    "/sbin/launchd",
    "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
    AE(2025),
    "/Applications/Adobe After Effects 2025/Adobe After Effects Render Engine 2025.app/Contents/MacOS/After Effects Render Engine",
    "/Applications/Adobe After Effects 2025/Adobe After Effects 2025.app/Contents/MacOS/CEPHtmlEngine.app/Contents/MacOS/CEPHtmlEngine",
    "/Applications/Adobe After Effects 2025/Adobe After Effects 2025.app/Contents/MacOS/dynamiclinkmanager",
  ].join("\n");
  assert.deepEqual(mac.parseRunningAe(ps), ["Adobe After Effects 2025"]);
  // The Render Engine on its own isn't After Effects.
  assert.deepEqual(mac.parseRunningAe("/Applications/Adobe After Effects 2026/Adobe After Effects Render Engine 2026.app/Contents/MacOS/After Effects Render Engine"), []);
  // Another install folder, two versions open at once: the newest first.
  assert.deepEqual(mac.parseRunningAe(`${AE(2024)}\n${AE(2026, "/Volumes/Apps")}  \n`), ["Adobe After Effects 2026", "Adobe After Effects 2024"]);
  assert.deepEqual(mac.parseRunningAe(""), []);
  // The AppleScript target: AE_APP, else the one that's open, else the bundle id.
  assert.equal(mac.targetForAe({ running: ["Adobe After Effects 2025"] }), 'application "Adobe After Effects 2025"');
  assert.equal(mac.targetForAe({ envName: "Adobe After Effects (Beta)", running: ["Adobe After Effects 2025"] }), 'application "Adobe After Effects (Beta)"');
  assert.equal(mac.targetForAe({}), 'application id "com.adobe.AfterEffects.application"');
  assert.equal(mac.BUNDLE_IDS.aftereffects, "com.adobe.AfterEffects.application");
  assert.equal(mac.appLabel('application id "com.adobe.AfterEffects.application"'), "After Effects");
  assert.equal(mac.parseEtime("01-02:03:04"), 86400 + 7384);
  assert.equal(mac.parseEtime("05:06"), 306);
  assert.deepEqual([...mac.parseWindowList("12,1440,875,0;99,480,220,8;").entries()], [[12, { w: 1440, h: 875, layer: 0 }], [99, { w: 480, h: 220, layer: 8 }]]);
});

test("Mac: an app is running only when its own program is, not a helper left in its bundle", () => {
  // Seen live (Nov 16): Photoshop had quit, its crash reporter stayed, Komposit read Photoshop
  // as running (pgrep -f "Adobe Photoshop.*.app/Contents/MacOS"), and the next script launched it.
  const leftovers = [
    "    1 /sbin/launchd",
    "16967 /Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app/Contents/Frameworks/AdobeCrashReporter.framework/Versions/A/Adobe Crash Processor.app/Contents/MacOS/Adobe Crash Processor",
    "  300 /Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app/Contents/MacOS/node",
    "  301 /Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app/Contents/MacOS/LogTransport2.app/Contents/MacOS/LogTransport2",
    "  302 /Applications/Adobe Illustrator 2026/Adobe Illustrator.app/Contents/MacOS/AIMonitor.app/Contents/MacOS/AIMonitor",
    "  303 /Applications/Adobe Illustrator 2026/Adobe Illustrator.app/Contents/Frameworks/AdobeCrashReporter.framework/Versions/A/Adobe Crash Processor.app/Contents/MacOS/Adobe Crash Processor",
    "42228 /Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/crashpad_handler",
    "  304 /Applications/Adobe After Effects 2026/Adobe After Effects Render Engine 2026.app/Contents/MacOS/After Effects Render Engine",
  ].join("\n");
  for (const app of ["illustrator", "photoshop", "aftereffects"]) assert.deepEqual(mac.appPids(leftovers, app), [], app);
  const open = [
    leftovers,
    "44382 /Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app/Contents/MacOS/Adobe Photoshop 2026",
    "  500 /Applications/Adobe Illustrator 2026/Adobe Illustrator.app/Contents/MacOS/Adobe Illustrator",
    "42175 /Applications/Adobe After Effects 2026/Adobe After Effects 2026.app/Contents/MacOS/After Effects",
    "  600 /Volumes/Apps/Adobe Photoshop (Beta)/Adobe Photoshop (Beta).app/Contents/MacOS/Adobe Photoshop (Beta)",
  ].join("\n");
  assert.deepEqual(mac.appPids(open, "photoshop"), [44382, 600]);
  assert.deepEqual(mac.appPids(open, "illustrator"), [500]);
  assert.deepEqual(mac.appPids(open, "aftereffects"), [42175]);
  assert.deepEqual(mac.appPids(open, "premiere"), []);
  // Premiere Pro's own MacOS folder holds its helpers too (CEPHtmlEngine runs Komposit's panel):
  // only its main program counts.
  const pr = "/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/MacOS";
  const helpers = [`  700 ${pr}/CEPHtmlEngine.app/Contents/MacOS/CEPHtmlEngine`, `  701 ${pr}/dynamiclinkmanager`, `  702 ${pr}/crashpad_handler`, `  703 ${pr}/PProHeadless`].join("\n");
  assert.deepEqual(mac.appPids(helpers, "premiere"), [], "helpers left after Premiere quits aren't Premiere");
  assert.deepEqual(mac.appPids(`${helpers}\n  777 ${pr}/Adobe Premiere Pro 2026`, "premiere"), [777]);
});

test("Windows: the helper's window list maps to the Mac's shape (layer 8 = modal dialog)", () => {
  const list = [
    { hwnd: 100, cls: "Afx:Main", title: "Adobe After Effects 2026", w: 1900, h: 1000, visible: true, enabled: false, owner: 0, ownerEnabled: null },
    { hwnd: 101, cls: "#32770", title: "After Effects", w: 420, h: 180, visible: true, enabled: true, owner: 100, ownerEnabled: false },
    { hwnd: 102, cls: "AE_Panel", title: "", w: 600, h: 400, visible: true, enabled: true, owner: 100, ownerEnabled: false },
    { hwnd: 103, cls: "Tooltip", title: "", w: 60, h: 20, visible: true, enabled: true, owner: 0, ownerEnabled: null },
    { hwnd: 104, cls: "#32770", title: "hidden", w: 400, h: 300, visible: false, enabled: true, owner: 100, ownerEnabled: false },
    { hwnd: 105, cls: "Palette", title: "", w: 300, h: 500, visible: true, enabled: true, owner: 100, ownerEnabled: true },
  ];
  const m = win.classifyWindows(list);
  assert.equal(m.get(100)!.layer, 0, "the main window");
  assert.equal(m.get(101)!.layer, 8, "a standard dialog box");
  assert.equal(m.get(102)!.layer, 8, "a custom window while its owner is disabled: modal");
  assert.equal(m.get(105)!.layer, 0, "a floating panel of an enabled window isn't modal");
  assert.ok(!m.has(104), "invisible windows are ignored");
  assert.equal(win.classifyWindows(null).size, 0);
  const base = win.classifyWindows([list[0], list[5]]);
  assert.deepEqual(newDialogs(base, m), [101, 102]);
});

test("Windows: COM command lines and how failures read", () => {
  assert.deepEqual(win.comArgs("photoshop", "C:\\t\\a.jsx", "C:\\t\\a.txt", { retryMs: 5000 }), ["jsx", "--progid", "Photoshop.Application", "--script", "C:\\t\\a.jsx", "--out", "C:\\t\\a.txt", "--retry-ms", "5000"]);
  const e1 = win.comError("illustrator", { code: "NOT_INSTALLED", json: { error: "Illustrator.Application is not registered" } });
  assert.equal(e1.code, "APP_NOT_INSTALLED");
  assert.match(e1.message, /^Illustrator isn't installed on this PC/);
  const e2 = win.comError("photoshop", { code: "BUSY", json: { error: "Call was rejected by callee." } });
  assert.equal(e2.code, "APP_BUSY");
  assert.match(e2.message, /If it's showing a dialog, close it/);
  const e3 = win.comError("photoshop", { code: "GONE", json: { error: "The RPC server is unavailable. (0x800706BA)" } });
  assert.equal(classify(e3.message), "crash", "the incident log calls a vanished app a crash");
  assert.equal(win.comError("illustrator", { code: "NO_HELPER" }).code, "NO_HELPER");
  assert.deepEqual(win.cscArgs("K.cs", "k.exe").slice(-2), ["/r:System.Drawing.dll", "K.cs"]);
  assert.deepEqual(win.parseCsvLine('"a ""b"" c","2"'), ['a "b" c', "2"]);
  assert.deepEqual(win.parseTasklist('"AfterFX.exe","1234","Console","1","1,234 K"\r\nINFO: x\r\n'), [{ name: "AfterFX.exe", pid: 1234 }]);
  assert.equal(win.exeFromCommand('"C:\\Program Files\\Adobe\\Adobe Photoshop 2026\\Photoshop.exe" /automation'), "C:\\Program Files\\Adobe\\Adobe Photoshop 2026\\Photoshop.exe");
  assert.equal(win.exeFromCommand("C:\\Adobe\\Illustrator.exe /Automation"), "C:\\Adobe\\Illustrator.exe");
});

test("Windows: After Effects' result file, found in the script and awaited", async () => {
  const path = "C:\\Users\\Ana Lucía\\AppData\\Local\\Temp\\komposit\\result-1.json";
  assert.equal(win.aeResultFileOf(wrap("return 1;", { write: path, viaEval: true })), path, "Windows paths survive the JSON escaping");
  assert.equal(win.aeResultFileOf(wrap("return 1;")), null, "no file for Illustrator/Photoshop scripts");
  const dir = mkdtempSync(join(tmpdir(), "kp-win-"));
  try {
    const f = join(dir, "r.json");
    setTimeout(() => writeFileSync(f, '{"ok":true,'), 50); // half-written
    setTimeout(() => writeFileSync(f, '\uFEFF{"ok":true,"data":1}'), 300);
    assert.equal(await win.waitForJsonFile(f, { timeoutMs: 3000, everyMs: 20 }), "ok");
    assert.equal(await win.waitForJsonFile(join(dir, "never.json"), { timeoutMs: 100, everyMs: 20 }), "timeout");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    assert.equal(await win.waitForJsonFile(join(dir, "never.json"), { timeoutMs: 3000, everyMs: 20, signal: ac.signal }), "aborted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("After Effects' scripting setting, read from its prefs file (CR line endings on a Mac)", () => {
  const prefs = '["Main Pref Section v2"]\r\n\t"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "1"\r\n';
  assert.equal(parseAePref(prefs), true);
  assert.equal(parseAePref(prefs.replace('"1"', '"0"')), false);
  assert.equal(parseAePref('["Main Pref Section v2"]\r\t"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "1"\r'), true);
  assert.equal(parseAePref("nothing here"), null);
  const dir = mkdtempSync(join(tmpdir(), "kp-adobe-"));
  try {
    for (const v of ["Adobe After Effects 2025", "Adobe After Effects 2026", "Adobe After Effects 2024 (Beta)"]) {
      mkdirSync(join(dir, v, "Support Files"), { recursive: true });
      writeFileSync(join(dir, v, "Support Files", "AfterFX.exe"), "");
    }
    const hit = win.newestAdobeExe("Adobe After Effects", ["Support Files", "AfterFX.exe"], dir);
    assert.ok(hit && hit.includes("Adobe After Effects 2026"), String(hit));
    assert.equal(win.newestAdobeExe("Adobe Premiere", ["x.exe"], dir), null);
    const base = join(dir, "prefs");
    mkdirSync(join(base, "26.5"), { recursive: true });
    writeFileSync(join(base, "26.5", "Adobe After Effects 26.5 Prefs.txt"), prefs.replace('"1"', '"0"'));
    assert.equal(aeScriptWritesPref(base), false);
    assert.equal(aeScriptWritesPref(join(dir, "missing")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dialog watch: only new, dialog-sized windows count; plain hints; what the agent may press", () => {
  const base = new Map([[1, { w: 1440, h: 875, layer: 0 }], [2, { w: 1200, h: 828, layer: 0 }]]);
  const now = new Map([...base, [7, { w: 480, h: 220, layer: 0 }], [8, { w: 40, h: 20, layer: 0 }]]);
  assert.deepEqual(newDialogs(base, now), [7]);
  assert.match(dialogText("illustrator"), /^Illustrator seems to be showing a dialog/);
  const save = { app: "photoshop", readable: true, title: "Adobe Photoshop", text: "Save changes to “poster.psd” before closing?", buttons: ["Don’t Save", "Cancel", "Save"], fields: 0 };
  assert.equal(dialogText("photoshop", save), "Photoshop is showing a dialog (Adobe Photoshop): “Save changes to “poster.psd” before closing?” Its buttons: Don’t Save, Cancel, Save. Answer it and this carries on.");
  assert.equal(dialogText("aftereffects", { app: "aftereffects", readable: true, title: "", text: "", buttons: ["OK"], fields: 0 }), "After Effects is showing a dialog, with the buttons: OK. Answer it and this carries on.");
  for (const b of ["OK", "Cancel", "Close", "Continue", "Skip"]) assert.equal(agentMayPress(b), true, b);
  for (const b of ["Save", "Don’t Save", "Don't Save", "Dont Save", "Discard", "Delete", "Replace", "Overwrite", "Revert", "Quit", ""]) assert.equal(agentMayPress(b), false, b);
});

test("a modal-layer window is a dialog only when the system lists one (Illustrator's hidden window, an export's progress window)", async () => {
  // Nov 16, a day's real work: 16 "Illustrator seems to be showing a dialog" waits with no
  // dialog (exports and long edits), and the AI was told Illustrator was blocked.
  const none = createFakeTransport({ dialogs: () => ({ dialogs: [] }) });
  const one = createFakeTransport({ dialogs: () => ({ dialogs: [{ title: "Save", text: ["Replace it?"], buttons: ["Cancel", "Replace"] }] }) });
  const denied = createFakeTransport({ dialogs: () => ({ denied: true }) });
  assert.equal((await readDialog(none, "illustrator")).state, "no");
  assert.equal((await readDialog(one, "illustrator")).state, "yes");
  assert.equal((await readDialog(denied, "illustrator")).state, "unknown");
  assert.equal(layersMeanDialog("illustrator", await readDialog(none, "illustrator")), false);
  assert.equal(layersMeanDialog("photoshop", await readDialog(none, "photoshop")), false);
  assert.equal(layersMeanDialog("illustrator", await readDialog(one, "illustrator")), true);
  // Without Accessibility: the layers stand, except Illustrator's, which always has one up.
  assert.equal(layersMeanDialog("photoshop", await readDialog(denied, "photoshop")), true);
  assert.equal(layersMeanDialog("illustrator", await readDialog(denied, "illustrator")), false);
  // After Effects can't be read while a script runs: its layers stand.
  assert.equal(layersMeanDialog("aftereffects", await readDialog(none, "aftereffects")), true);

  // The step watcher: a new window that stays (an export's progress) says nothing when the
  // system lists no dialog, and still speaks up for a real one.
  const base: WindowMap = new Map([[1, { w: 1440, h: 822, layer: 0 }], [2, { w: 256, h: 299, layer: 8 }]]);
  const withProgress: WindowMap = new Map([...base, [9, { w: 420, h: 140, layer: 0 }]]);
  const run = async (dialogs: () => unknown) => {
    let looks = 0;
    const t = createFakeTransport({ windows: () => (looks++ === 0 ? base : withProgress), dialogs: dialogs as never });
    const said: (string | null)[] = [];
    const stop = createDialogWatcher(t).watch("illustrator", (text) => said.push(text), { startAfterMs: 5, everyMs: 5 });
    await new Promise((r) => setTimeout(r, 80));
    stop();
    return said;
  };
  assert.deepEqual(await run(() => ({ dialogs: [] })), []);
  const real = await run(() => ({ dialogs: [{ title: "Adobe Illustrator", text: ["Could not complete the export."], buttons: ["OK"] }] }));
  assert.match(String(real[0]), /^Illustrator is showing a dialog/);
});

test("After Effects readiness: not open, a dialog up, still starting, ready", async () => {
  const notOpen = createAeReady(createFakeTransport({ running: { aftereffects: false } }));
  assert.equal((await notOpen({ waitMs: 0 })).code, "AE_NOT_RUNNING");
  const dialog = createAeReady(
    createFakeTransport({
      windows: () => new Map([[1, { w: 1900, h: 1000, layer: 0 }], [2, { w: 400, h: 160, layer: 8 }]]),
      dialogs: () => ({ dialogs: [{ title: "After Effects", text: ["Unable to execute script at line 3."], buttons: ["OK"] }] }),
    }),
  );
  const d = await dialog({ waitMs: 0 });
  assert.equal(d.code, "AE_DIALOG");
  assert.match(d.message || "", /^After Effects is showing a dialog, and won't run scripts until it's closed\. It \(After Effects\): “Unable to execute script at line 3\.” Its buttons: OK\./);
  let slept = 0;
  const starting = createAeReady(createFakeTransport({ uptime: 3 }), { sleep: async () => { slept++; } });
  assert.equal((await starting({ waitMs: 0 })).code, "AE_STARTING");
  assert.equal(slept, 0, "a zero wait looks once");
  assert.equal((await createAeReady(createFakeTransport())({ waitMs: 0 })).ok, true);
});

test("After Effects' own Executing Script window is not a dialog, and one that closes within a second isn't either", async () => {
  // Seen live (After Effects 2026, Nov 16): every script over about 1 s shows "Executing
  // Script ..." at the modal layer; it closes 150-350 ms after the script returns (a 431x245
  // window flashes too). The next call was refused as "After Effects is showing a dialog".
  assert.deepEqual([...mac.parseWindowList("12,1440,822,0,Adobe%20After%20Effects%202026;31,363,177,8,Executing%20Script%20...;40,100,100,3,").entries()], [
    [12, { w: 1440, h: 822, layer: 0, title: "Adobe After Effects 2026" }],
    [31, { w: 363, h: 177, layer: 8, title: "Executing Script ..." }],
    [40, { w: 100, h: 100, layer: 3 }],
  ]);
  const main: WindowMap = new Map([[1, { w: 1440, h: 822, layer: 0 }]]);
  const progress: WindowMap = new Map([...main, [31, { w: 363, h: 177, layer: 8, title: "Executing Script ..." }]]);
  assert.equal(hasModal(progress), false);
  assert.deepEqual(newDialogs(main, progress), []);
  // Without its title (no Screen Recording permission), a modal that's gone a moment later.
  let looks = 0;
  const lingering = createAeReady(createFakeTransport({ windows: () => (++looks <= 2 ? new Map([...main, [32, { w: 431, h: 245, layer: 8 }]]) : main) }), { sleep: async () => {} });
  assert.equal((await lingering({ waitMs: 0 })).ok, true);
  assert.ok(looks >= 3);
  // A dialog that stays is still one.
  const stays = createAeReady(createFakeTransport({ windows: () => new Map([...main, [33, { w: 400, h: 160, layer: 8 }]]) }), { sleep: async () => {} });
  assert.equal((await stays({ waitMs: 0 })).code, "AE_DIALOG");
  // Unreadable in After Effects: it may be the Executing Script window, so not "close it".
  assert.equal(dialogText("aftereffects"), "After Effects seems to be busy or showing a dialog. If its window says Executing Script, it's still working on this step; if it's a dialog, answer it and this carries on.");
});

test("guide: the index lists topics, a topic serves its section, unknown topics list what there is", () => {
  const g = parseGuide("# Demo ExtendScript\n\nIntro line.\n\n## Results\n- Return values.\n\n## Text layers\n- Add a TEXT layer: do x.\n- More.\n");
  assert.equal(g.title, "Demo ExtendScript");
  assert.deepEqual(g.sections.map((s) => s.slug), ["results", "text-layers"]);
  const index = serveGuide(g);
  assert.match(index, /^Demo ExtendScript\n\nIntro line\.\n/);
  assert.match(index, /- text-layers: Add a TEXT layer: do x\./);
  assert.equal(serveGuide(g, "text"), "Demo ExtendScript: Text layers\n\n- Add a TEXT layer: do x.\n- More.");
  assert.equal(serveGuide(g, "Text Layers"), serveGuide(g, "text-layers"));
  assert.match(serveGuide(g, "lasers"), /no section on "lasers"\. Its topics: results, text-layers\./);
  assert.match(serveGuide(g, "all"), /## Results\n- Return values\.\n\n## Text layers/);
});

test("envelope: an error's line counts from the code that was sent, not the whole script (Nov 16: every line was 38 too high)", () => {
  // ExtendScript errors carry .line, counted in the whole script; Node's don't, so the test
  // throws one with the line where `needle` sits in the script that runs.
  const lineIn = (src: string, needle: string) => src.split("\n").findIndex((l) => l.includes(needle)) + 1;
  for (const guard of [undefined, { before: "var a = 1;\nvar b = 2;", setup: "var c = 3;", after: "c = 0;" }]) {
    const probe = wrap("var x = 1;\nNEEDLE;", { guard });
    const at = lineIn(probe, "NEEDLE");
    assert.ok(at > 30, "the code sits far down the script");
    const env = parseEnvelope(run(wrap(`var x = 1;\nthrow { message: "Target layer cannot be modified", line: ${at} };`, { guard })), "Illustrator");
    assert.equal(env.error, "Target layer cannot be modified (line 2)");
  }
  // A line outside the code (the guard's own) is left out rather than given wrong.
  const env = parseEnvelope(run(wrap(`throw { message: "c.ai is not open in Illustrator anymore.", line: 3 };`)), "Illustrator");
  assert.equal(env.error, "c.ai is not open in Illustrator anymore.");
  // Compiled with eval (After Effects, Windows): $.line marks where the code starts when the app
  // has it; without it the app's number stays as it was.
  const evalEnv = parseEnvelope(run(wrap(`throw { message: "bad", line: 7 };`, { viaEval: true })), "After Effects");
  assert.equal(evalEnv.error, "bad (line 7)");
  const marked = parseEnvelope(run(wrap(`var a = 1;\nthrow { message: "bad", line: 12 };`, { viaEval: true }), { $: { line: 10 } }), "After Effects");
  assert.equal(marked.error, "bad (line 2)");
  // The base for a syntax error the app reports about the whole script (codeLine, runner.ts).
  assert.equal(codeLineBase(wrap("x;")), lineIn(wrap("NEEDLE;"), "NEEDLE") - 1);
  assert.equal(codeLineBase(wrap("x;", { viaEval: true })), null);
});

test("envelope: JSON works in every script, without touching the app's globals", () => {
  const src = wrap(`var o = JSON.parse('{"a":[1,"b"]}'); return JSON.stringify({ n: o.a[0], s: o.a[1], q: 'x"y' });`);
  // ES3 has no JSON: the script brings its own.
  const ctx: Record<string, unknown> = {};
  const env = parseEnvelope(run(`JSON = undefined;\n${src}`, ctx), "Illustrator");
  assert.equal(env.ok, true, String(env.error));
  assert.equal(env.data, '{"n":1,"s":"b","q":"x\\"y"}');
  assert.equal(ctx.JSON, undefined, "no global JSON is left behind");
  // An app that has JSON keeps its own.
  assert.equal(parseEnvelope(run(src), "Illustrator").data, '{"n":1,"s":"b","q":"x\\"y"}');
});

test("hints: the common Illustrator and Photoshop errors get one plain next step, after the app's own words", () => {
  const cases: [string, string, RegExp][] = [
    ["illustrator", "Target layer cannot be modified (line 4)", /^Target layer cannot be modified \(line 4\)\. Hint: The layer being drawn into.*locked or hidden.*put them back as they were/],
    ["illustrator", "an Illustrator error occurred: 1346458189 ('MRAP') (line 2)", /Hint: This is Illustrator's PARM error: it rejected a value on that line/],
    ["illustrator", "an Illustrator error occurred: 1112237433 ('yeKB') (line 1)", /Hint: A menu command \(app\.executeMenuCommand\)/],
    ["illustrator", "No such element (line 3)", /Hint: Nothing has that name: getByName/],
    ["photoshop", "No such element", /^No such element\. Hint: Nothing has that name/],
    ["illustrator", "Object is invalid (line 9)", /Hint: The script used a reference to an item that no longer exists/],
    ["illustrator", "The requested property is not available for this type of text frame. (line 1)", /Hint: Text frames come in three kinds \(tf\.kind\)/],
    ["illustrator", "Not implemented (line 9)", /Hint: This object doesn't support that property/],
    ["illustrator", "Illegal Argument (line 32)", /Hint: A value passed on that line is of the wrong kind/],
    ["illustrator", "Required value is missing (line 6)", /Hint: A call on that line got undefined.*app\.textFonts\.getByName/],
    ["illustrator", "the operation was cancelled (line 64)", /Hint: The app cancelled it.*use the save and export tools/],
    ["photoshop", "doc.revert is not a function (line 1)", /Hint: Photoshop's scripting has no doc\.revert\(\).*historyStates.*'Rvrt'/],
    ["illustrator", "b.map is not a function (line 3)", /Hint: ExtendScript is ES3: arrays have no map, forEach/],
    ["photoshop", "X is not open in Photoshop anymore.", /^X is not open in Photoshop anymore\. Hint: That document was closed/],
  ];
  for (const [app, msg, want] of cases) assert.match(withHint(app, msg), want, msg);
  assert.equal(scriptHint("photoshop", "an Illustrator error occurred: 1346458189 ('MRAP')"), null, "Illustrator's codes are Illustrator's");
  assert.equal(withHint("illustrator", "Something new (line 2)"), "Something new (line 2)");
  assert.equal(scriptHint("illustrator", "No such element. Hint: already"), null, "never twice");
});

test("a script that doesn't compile on a Mac: the app's line is put in the code's lines", async () => {
  const transport = createFakeTransport({
    fail: (_app, source) => {
      const line = source.split("\n").findIndex((l) => l.includes("BROKEN")) + 1;
      return new KitError(`application "Adobe Illustrator" error (osascript exit 1):\n/tmp/x.applescript:202:228: execution error: Adobe Illustrator got an error: Error 25: Expected: :.Line: ${line}->  BROKEN ? (-2700)`, "APP_ERROR");
    },
  });
  const scratch = mkdtempSync(join(tmpdir(), "kp-runner-"));
  try {
    const { createRunner } = await import("./runner.ts");
    const { createScratch } = await import("./scratch.ts");
    const runner = createRunner({ transport, scratch: createScratch(scratch), incidents: createIncidentLog(undefined, async () => true) });
    const env = await runner.stdout("illustrator", "var a = 1;\nvar b = 2;\nBROKEN ?");
    assert.equal(env.ok, false);
    assert.match(String(env.error), /^Illustrator couldn't run the script: Error 25: Expected: : \(line 3\): BROKEN \?/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  assert.equal(codeLine("Expected: ;.Line: 3-> x", "var __kpBase = 40, __kpKnown", "x"), "Expected: ;.Line: 3-> x", "a line outside the code stays as it was");
});

test("incidents: a long script keeps its start and its end (the step's own code comes after the chat's helpers)", () => {
  const got: Incident[] = [];
  const log = createIncidentLog((i) => got.push(i), async () => true);
  log.record({ app: "illustrator", kind: "script-error", message: "x", script: `${"function h(){}\n".repeat(600)}THE_STEP();` });
  assert.ok(got[0]!.script!.length < 4100);
  assert.match(got[0]!.script!, /^function h\(\)\{\}\n/);
  assert.match(got[0]!.script!, /characters left out/);
  assert.match(got[0]!.script!, /THE_STEP\(\);$/);
});
