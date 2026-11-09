// The Windows platform layer's pure parts: command lines, parsers, path rules,
// the dialog classification, error mapping and the After Effects result-file
// handshake. These run on any OS (path.win32 inside win.mjs). What they can't
// cover, a real Illustrator/Photoshop/After Effects on Windows, is in
// docs/windows-testing.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as win from "../platform/win.mjs";
import * as mac from "../platform/mac.mjs";
import platform from "../platform/index.mjs";
import { wrap } from "../bridges/extendscript.mjs";
import { newDialogs } from "../dialogwatch.mjs";
import { classify } from "../incidents.mjs";
import { compileCommands, keepModuleFile, keepAppFile, cscPath, isccPath } from "../../packaging/windows/build.mjs";

test("platform: picks the module for this OS; both export the same names", () => {
  assert.equal(platform.name, process.platform === "win32" ? "win" : "mac");
  const names = (m) => Object.keys(m).filter((k) => !/^(parse|expand|known|classify|com|cscArgs|aeResult|waitFor|newestAdobe|exeFrom|helperCandidates|helperPathSync|processes|afterEffectsExe|PROGID|EXE|parseAePref|aeScriptWritesPref|comServerPath|target)/.test(k)).sort();
  assert.deepEqual(names(win), names(mac));
  assert.equal(win.keys.mod, "Ctrl");
  assert.equal(mac.keys.mod, "Cmd");
  assert.equal(win.folderPrompts, false);
  assert.equal(mac.folderPrompts, true);
});

test("paths: settings in %APPDATA%, logs in %LOCALAPPDATA%", () => {
  const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
  process.env.APPDATA = "C:\\Users\\Ana Lucía\\AppData\\Roaming";
  process.env.LOCALAPPDATA = "C:\\Users\\Ana Lucía\\AppData\\Local";
  try {
    assert.equal(win.defaultDataDir(), "C:\\Users\\Ana Lucía\\AppData\\Roaming\\Komposit");
    assert.equal(win.logFile(), "C:\\Users\\Ana Lucía\\AppData\\Local\\Komposit\\Logs\\server.log");
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("isInside: case-insensitive, either slash, no ../ escapes", () => {
  const home = "C:\\Users\\ana";
  assert.ok(win.isInside(home, "C:\\Users\\ana\\Desktop\\poster.ai"));
  assert.ok(win.isInside(home, "c:\\users\\ANA\\desktop"));
  assert.ok(win.isInside(home, "C:/Users/ana/Documents/x.psd"));
  assert.ok(win.isInside(home, home));
  assert.ok(win.isInside("C:\\Users\\ana\\", "C:\\Users\\ana\\a"));
  assert.ok(!win.isInside(home, "C:\\Users\\ana\\..\\bob\\x"));
  assert.ok(!win.isInside(home, "C:\\Users\\anabel\\x"), "a sibling with the same prefix");
  assert.ok(!win.isInside(home, "D:\\Users\\ana\\x"));
  assert.ok(!win.isInside(home, ""));
  assert.ok(!win.isInside(home, null));
});

test("registry: parse `reg query` output and expand %VARS%", () => {
  const out = [
    "",
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
    "    Desktop    REG_EXPAND_SZ    %USERPROFILE%\\OneDrive\\Desktop",
    "    Personal    REG_EXPAND_SZ    D:\\Work\\Documents",
    "    {374DE290-123F-4565-9164-39C4925E467B}    REG_EXPAND_SZ    %USERPROFILE%\\Downloads",
    "    (Default)    REG_SZ    ",
    "",
  ].join("\r\n");
  const v = win.parseRegQuery(out);
  assert.equal(v.Desktop, "%USERPROFILE%\\OneDrive\\Desktop");
  assert.equal(v.Personal, "D:\\Work\\Documents");
  assert.equal(v["(Default)"], "");
  assert.equal(win.expandEnv("%userprofile%\\x", { USERPROFILE: "C:\\Users\\ana" }), "C:\\Users\\ana\\x");
  assert.equal(win.expandEnv("%NOPE%\\x", {}), "%NOPE%\\x");
  const f = win.knownFoldersFrom(v, { USERPROFILE: "C:\\Users\\ana" }, "C:\\Users\\ana");
  assert.deepEqual(f, { desktop: "C:\\Users\\ana\\OneDrive\\Desktop", downloads: "C:\\Users\\ana\\Downloads", documents: "D:\\Work\\Documents" });
  assert.deepEqual(win.knownFoldersFrom({}, {}, "C:\\Users\\ana"), { desktop: "C:\\Users\\ana\\Desktop", downloads: "C:\\Users\\ana\\Downloads", documents: "C:\\Users\\ana\\Documents" });
  const ae = win.parseRegQuery("\r\nHKEY_LOCAL_MACHINE\\...\\AfterFX.exe\r\n    (Default)    REG_SZ    C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe\r\n");
  assert.equal(ae["(Default)"], "C:\\Program Files\\Adobe\\Adobe After Effects 2026\\Support Files\\AfterFX.exe");
});

test("processes: tasklist CSV, quotes and localized info lines", () => {
  assert.deepEqual(win.parseCsvLine('"Illustrator.exe","1234","Console","1","1,234,567 K"'), ["Illustrator.exe", "1234", "Console", "1", "1,234,567 K"]);
  assert.deepEqual(win.parseCsvLine('"a ""b"" c","2"'), ['a "b" c', "2"]);
  const out = '"System Idle Process","0","Services","0","8 K"\r\n"Photoshop.exe","4321","Console","1","2,000,000 K"\r\n"AfterFX.exe","999","Console","1","900,000 K"\r\n';
  assert.deepEqual(win.parseTasklist(out).map((p) => p.name), ["System Idle Process", "Photoshop.exe", "AfterFX.exe"]);
  assert.equal(win.parseTasklist(out)[1].pid, 4321);
  assert.deepEqual(win.parseTasklist("INFORMATION: Aucune tâche en cours d'exécution ne correspond aux critères spécifiés.\r\n"), []);
  assert.deepEqual(win.EXE, { illustrator: "Illustrator.exe", photoshop: "Photoshop.exe", aftereffects: "AfterFX.exe" });
});

test("windows: the helper's list maps to the Mac's shape (layer 8 = modal dialog)", () => {
  const list = [
    { hwnd: 100, cls: "Afx:Main", title: "Adobe After Effects 2026", w: 1900, h: 1000, visible: true, enabled: false, owner: 0, ownerEnabled: null },
    { hwnd: 101, cls: "#32770", title: "After Effects", w: 420, h: 180, visible: true, enabled: true, owner: 100, ownerEnabled: false },
    { hwnd: 102, cls: "AE_Panel", title: "", w: 600, h: 400, visible: true, enabled: true, owner: 100, ownerEnabled: false },
    { hwnd: 103, cls: "Tooltip", title: "", w: 60, h: 20, visible: true, enabled: true, owner: 0, ownerEnabled: null },
    { hwnd: 104, cls: "#32770", title: "hidden", w: 400, h: 300, visible: false, enabled: true, owner: 100, ownerEnabled: false },
    { hwnd: 105, cls: "Palette", title: "", w: 300, h: 500, visible: true, enabled: true, owner: 100, ownerEnabled: true },
  ];
  const m = win.classifyWindows(list);
  assert.equal(m.get(100).layer, 0, "the main window");
  assert.equal(m.get(101).layer, 8, "a standard dialog box");
  assert.equal(m.get(102).layer, 8, "a custom window while its owner is disabled: modal");
  assert.equal(m.get(105).layer, 0, "a floating panel of an enabled window isn't modal");
  assert.ok(!m.has(104), "invisible windows are ignored");
  assert.equal(win.classifyWindows(null).size, 0);
  // dialogwatch: only new, dialog-sized windows count, on Windows too.
  const base = win.classifyWindows([list[0], list[5]]);
  assert.deepEqual(newDialogs(base, m), [101, 102]);
});

test("COM: the helper command line and how its failures read", () => {
  assert.deepEqual(win.comArgs("photoshop", "C:\\t\\a.jsx", "C:\\t\\a.txt", { retryMs: 5000 }), ["jsx", "--progid", "Photoshop.Application", "--script", "C:\\t\\a.jsx", "--out", "C:\\t\\a.txt", "--retry-ms", "5000"]);
  assert.equal(win.comArgs("illustrator", "s", "o")[2], "Illustrator.Application");
  const e1 = win.comError("illustrator", { code: "NOT_INSTALLED", json: { error: "Illustrator.Application is not registered" } });
  assert.equal(e1.code, "APP_NOT_INSTALLED");
  assert.match(e1.message, /^Illustrator isn't installed on this PC/);
  const e2 = win.comError("photoshop", { code: "BUSY", json: { error: "Call was rejected by callee." } });
  assert.equal(e2.code, "APP_BUSY");
  assert.match(e2.message, /If it's showing a dialog, close it/);
  const e3 = win.comError("photoshop", { code: "GONE", json: { error: "The RPC server is unavailable. (0x800706BA)" } });
  assert.equal(classify(e3.message), "crash", "the incident log calls a vanished app a crash");
  const e4 = win.comError("illustrator", { code: "SCRIPT", json: { error: "Error 21: undefined is not an object" } });
  assert.match(e4.message, /^Illustrator error \(COM\): Error 21/);
  assert.equal(win.comError("illustrator", { code: "NO_HELPER" }).code, "NO_HELPER");
  assert.match(win.comError("aftereffects", { code: "EXIT_9", stderr: "boom" }).message, /After Effects error \(EXIT_9\): boom/);
  assert.equal(classify("Photoshop didn't answer in time. If it's showing a dialog, close it."), "timeout");
});

test("After Effects: the result file a wrapped script writes, found and awaited", async () => {
  const path = "C:\\Users\\Ana Lucía\\AppData\\Local\\Temp\\komposit\\result-1.json";
  const src = wrap("return 1;", { write: path, viaEval: true });
  assert.equal(win.aeResultFileOf(src), path, "Windows paths survive the JSON escaping");
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

test("After Effects: the scripting preference and finding AfterFX.exe", () => {
  const prefs = '["Main Pref Section v2"]\r\n\t"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "1"\r\n';
  assert.equal(win.parseAePref(prefs), true);
  assert.equal(win.parseAePref(prefs.replace('"1"', '"0"')), false);
  assert.equal(win.parseAePref("nothing here"), null);
  const dir = mkdtempSync(join(tmpdir(), "kp-adobe-"));
  try {
    for (const v of ["Adobe After Effects 2025", "Adobe After Effects 2026", "Adobe After Effects 2024 (Beta)"]) {
      mkdirSync(join(dir, v, "Support Files"), { recursive: true });
      writeFileSync(join(dir, v, "Support Files", "AfterFX.exe"), "");
    }
    mkdirSync(join(dir, "Adobe Photoshop 2026"));
    const hit = win.newestAdobeExe("Adobe After Effects", ["Support Files", "AfterFX.exe"], dir);
    assert.ok(hit && hit.includes("Adobe After Effects 2026"), hit);
    assert.equal(win.newestAdobeExe("Adobe Premiere", ["x.exe"], dir), null);
    // The prefs file: the newest "Adobe After Effects <ver> Prefs.txt".
    const base = join(dir, "prefs");
    mkdirSync(join(base, "26.5"), { recursive: true });
    writeFileSync(join(base, "26.5", "Adobe After Effects 26.5 Prefs.txt"), prefs.replace('"1"', '"0"'));
    assert.equal(win.aeScriptWritesPref(base), false);
    assert.equal(win.aeScriptWritesPref(join(dir, "missing")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(win.exeFromCommand('"C:\\Program Files\\Adobe\\Adobe Photoshop 2026\\Photoshop.exe" /automation'), "C:\\Program Files\\Adobe\\Adobe Photoshop 2026\\Photoshop.exe");
  assert.equal(win.exeFromCommand("C:\\Adobe\\Illustrator.exe /Automation"), "C:\\Adobe\\Illustrator.exe");
});

test("helper: where it's looked for, and how a checkout builds it", () => {
  const c = win.helperCandidates({ env: { KOMPOSIT_WIN_HELPER: "C:\\K\\komposit-win.exe" }, execPath: "C:\\K\\node\\node.exe", root: "C:\\K\\app", dataDir: "C:\\Data\\Komposit" });
  assert.deepEqual(c, [
    "C:\\K\\komposit-win.exe",
    "C:\\K\\node\\komposit-win.exe",
    "C:\\K\\komposit-win.exe",
    "C:\\K\\app\\packaging\\windows\\build\\komposit-win.exe",
    "C:\\Data\\Komposit\\bin\\komposit-win.exe",
  ]);
  const a = win.cscArgs("C:\\src\\KompositWin.cs", "C:\\out\\komposit-win.exe");
  assert.ok(a.includes("/target:exe") && a.includes("/out:C:\\out\\komposit-win.exe") && a.at(-1) === "C:\\src\\KompositWin.cs");
});

test("Claude Code on Windows: only real executables, the usual install folders", () => {
  assert.deepEqual(win.claudeNames, ["claude.exe"]);
  const dirs = win.extraBinDirs().join("|");
  assert.match(dirs, /\.local\\bin/);
  assert.match(dirs, /npm\\node_modules\\@anthropic-ai\\claude-code\\bin/);
  assert.deepEqual(win.groupSpawnOptions, { windowsHide: true });
  assert.deepEqual(mac.groupSpawnOptions, { detached: true });
});

test("build: csc and Inno Setup command lines, and what gets staged", () => {
  const c = compileCommands("C:\\b", "C:\\w");
  assert.ok(c.helper.includes("/target:exe") && c.helper.at(-1).endsWith("KompositWin.cs"));
  assert.ok(c.tray.includes("/target:winexe") && c.tray.includes("/r:System.Windows.Forms.dll"));
  assert.ok(c.tray.some((a) => a.startsWith("/win32manifest:")) && c.tray.some((a) => a.startsWith("/win32icon:")));
  assert.equal(cscPath({ WINDIR: "D:\\Win" }), join("D:\\Win", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"));
  assert.equal(cscPath({ CSC: "X:\\csc.exe" }), "X:\\csc.exe");
  assert.equal(isccPath({ ISCC: "Y:\\ISCC.exe" }), "Y:\\ISCC.exe");
  for (const [p, keep] of [
    ["node_modules/@anthropic-ai/sdk/index.js", true],
    ["node_modules/@anthropic-ai/sdk/index.d.ts", false],
    ["node_modules/@anthropic-ai/sdk/index.js.map", false],
    ["node_modules/@anthropic-ai/sdk/README.md", false],
    ["node_modules/@anthropic-ai/sdk/src/", false],
    ["node_modules/.bin/", false],
    ["node_modules\\x\\lib\\a.mjs", true],
  ]) assert.equal(keepModuleFile(p), keep, p);
  assert.equal(keepAppFile("companion/test/x.test.mjs"), false);
  assert.equal(keepAppFile("companion/platform/win.mjs"), true);
});

test("mac: ps elapsed time parses", () => {
  assert.equal(mac.parseEtime("05:06"), 306);
  assert.equal(mac.parseEtime("02:03:04"), 7384);
  assert.equal(mac.parseEtime("1-02:03:04"), 93784);
});
