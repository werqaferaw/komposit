// Komposit's Windows transport, end to end, against stand-in Adobe apps. For
// CI on a PC without Adobe. It proves the plumbing, not Adobe's own scripting
// (that's docs/windows-testing.md):
//
//   Illustrator, Photoshop  in-process JScript COM components registered as
//     "Illustrator.Application" / "Photoshop.Application". DoJavaScript really
//     runs Komposit's wrapped ES3 script (JScript is ES3 too) against a stub
//     `app`, so the wrapper, its JSON encoder and the envelope are exercised,
//     along with the helper's COM client: ProgID lookup, CreateInstance,
//     late-bound DoJavaScript(code, missing, 1), the string result, UTF-8,
//     COM errors, timeouts and Stop. Not covered: out-of-process activation and
//     the busy-retry filter (an out-of-process .NET stand-in never got its
//     activation on GitHub's runner; see test/FakeAdobe.cs).
//   After Effects  test/FakeAdobe.cs as AfterFX.exe: a main window, the -r
//     launcher handoff and result file, real modal dialogs of both kinds.
//
//   node packaging/windows/fake-adobe.mjs      (after build.mjs compile + stage)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cscPath } from "./build.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STAGE = join(ROOT, "dist", "windows", "stage");
const HELPER = join(STAGE, "komposit-win.exe");
const work = mkdtempSync(join(tmpdir(), "kp-fake-"));
const BIN = join(work, "bin");
const FAKE = join(work, "fake");
const DATA = join(work, "data");
for (const d of [BIN, FAKE, DATA]) mkdirSync(d, { recursive: true });
process.env.KOMPOSIT_DATA_DIR = DATA;
process.env.KOMPOSIT_WIN_HELPER = HELPER;
process.env.KOMPOSIT_FAKE_DIR = FAKE;

const CLSID = { illustrator: "{6F7E2A10-4B1C-4E59-9C43-0A5D3B2E1F01}", photoshop: "{6F7E2A10-4B1C-4E59-9C43-0A5D3B2E1F02}" };
const PROGID = { illustrator: "Illustrator.Application", photoshop: "Photoshop.Application" };
const results = [];
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const d = await fn();
    results.push({ name, ok: true });
    console.log(`  ok    ${name} (${Date.now() - t0} ms)${d ? `: ${d}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (app) => (existsSync(join(FAKE, `log-${app}.txt`)) ? readFileSync(join(FAKE, `log-${app}.txt`), "utf8") : "");
function dumpLogs() {
  for (const app of ["illustrator", "photoshop", "aftereffects"]) {
    const l = log(app);
    if (l) console.log(`--- stand-in log: ${app}\n${l.split("\n").slice(-15).join("\n")}`);
  }
}
// Never let a hang eat the job.
setTimeout(() => {
  console.log("\nWATCHDOG: still running after 8 minutes; stopping.");
  dumpLogs();
  spawnSync("taskkill", ["/IM", "AfterFX.exe", "/F"], { windowsHide: true });
  process.exit(1);
}, 8 * 60000).unref();

console.log("Komposit Windows transport against stand-in Adobe apps");

// ---------- Illustrator and Photoshop: in-process JScript COM components ----------

// A Windows Script Component. Its DoJavaScript runs the script it's given
// against a stub Illustrator/Photoshop DOM, like the real apps run ExtendScript.
function wsc(app) {
  const doc = app === "photoshop" ? "Fake.psd" : "Fake.ai";
  return `<?xml version="1.0"?>
<component>
<registration description="Komposit test stand-in for ${app}" progid="${PROGID[app]}" version="1.00" classid="${CLSID[app]}"/>
<public>
  <method name="DoJavaScript"><parameter name="code"/><parameter name="args"/><parameter name="mode"/></method>
</public>
<script language="JScript"><![CDATA[
var FAKE_DIR = ${JSON.stringify(FAKE)};
var APP = ${JSON.stringify(app)};
function fakeLog(line) {
  try { var fso = new ActiveXObject("Scripting.FileSystemObject"); var f = fso.OpenTextFile(FAKE_DIR + "\\\\log-" + APP + ".txt", 8, true, 0); f.WriteLine(line); f.Close(); } catch (e) {}
}
function File(p) { this.fsName = p; this.name = String(p).replace(/^.*[\\\\\\/]/, ""); this.exists = true; }
var theDoc = { name: ${JSON.stringify(doc)}, fullName: new File("C:\\\\Fake\\\\" + ${JSON.stringify(doc)}), saved: true };
var app = { name: "Adobe " + APP, documents: { length: 1, 0: theDoc }, activeDocument: theDoc };
function DoJavaScript(code, args, mode) {
  code = String(code);
  fakeLog("call mode=" + mode + " argsType=" + (typeof args) + " length=" + code.length);
  // JScript (IE's engine) has a known bug that ExtendScript doesn't: eval of a
  // parenthesized function expression returns undefined. Komposit's wrapper
  // compiles the agent's code that way on Windows (and in After Effects on
  // both systems), so rewrite that one call to the array form JScript
  // evaluates correctly. Same scope, same result as in ExtendScript.
  var head = 'eval("(function(){', tail = '})")()';
  var i = code.indexOf(head), j = code.lastIndexOf(tail);
  if (i >= 0 && j > i) code = code.slice(0, i) + 'eval("[function(){' + code.slice(i + head.length, j) + '}]")[0]()' + code.slice(j + tail.length);
  var m = /__FAKE_SLEEP_(\\d+)__/.exec(code);
  if (m) { var t = new Date().getTime(); while (new Date().getTime() - t < Number(m[1])) {} }
  if (String(code).indexOf("__FAKE_THROW__") >= 0) throw new Error("Error 21: undefined is not an object.");
  return eval(code); // Komposit's wrapper: its last statement is the JSON envelope
}
]]></script>
</component>
`;
}

const regsvr = (args) => spawnSync("regsvr32", args, { encoding: "utf8", windowsHide: true, timeout: 30000 });
const wscPath = (app) => join(work, `fake-${app}.wsc`);
await check("register the Illustrator and Photoshop stand-ins (scrobj.dll)", () => {
  for (const app of ["illustrator", "photoshop"]) {
    writeFileSync(wscPath(app), wsc(app));
    const r = regsvr(["/s", "/n", `/i:${wscPath(app)}`, "scrobj.dll"]);
    assert(r.status === 0, `regsvr32 ${app}: exit ${r.status}`);
  }
});

const win = await import(pathToFileURL(join(STAGE, "app", "companion", "platform", "win.mjs")).href);
const es = await import(pathToFileURL(join(STAGE, "app", "companion", "bridges", "extendscript.mjs")).href);
const il = await import(pathToFileURL(join(STAGE, "app", "companion", "bridges", "illustrator.mjs")).href);
const ps = await import(pathToFileURL(join(STAGE, "app", "companion", "bridges", "photoshop.mjs")).href);
const ae = await import(pathToFileURL(join(STAGE, "app", "companion", "bridges", "aftereffects.mjs")).href);
const dw = await import(pathToFileURL(join(STAGE, "app", "companion", "dialogwatch.mjs")).href);
const incidents = () => (existsSync(join(DATA, "incidents.jsonl")) ? readFileSync(join(DATA, "incidents.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

console.log("COM: Illustrator, Photoshop (the helper's client code, Komposit's wrapper)");
let comWorks = false;
await check("the helper calls DoJavaScript through COM (30 s budget)", () => {
  const s = join(work, "probe.jsx");
  writeFileSync(s, "1 + 1");
  const r = spawnSync(HELPER, ["jsx", "--progid", "Illustrator.Application", "--script", s, "--out", join(work, "probe.txt")], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert(r.status === 0, `exit ${r.status} ${r.error?.code || ""}: ${r.stderr}`);
  const out = readFileSync(join(work, "probe.txt"), "utf8");
  assert(out === "2", `got ${JSON.stringify(out)}`);
  comWorks = true;
  return `returned ${out}`;
});
if (!comWorks) dumpLogs();
const comCheck = (name, fn) => (comWorks ? check(name, fn) : check(name, () => { throw new Error("skipped: COM to the stand-in doesn't work"); }));
await comCheck("Illustrator listDocuments: the real bridge script runs and its envelope comes back", async () => {
  const d = await il.listDocuments();
  assert(d.length === 1 && d[0].name === "Fake.ai" && d[0].path === "C:\\Fake\\Fake.ai" && d[0].active === true, JSON.stringify(d));
});
await comCheck("Photoshop listDocuments", async () => {
  const d = await ps.listDocuments();
  assert(d.length === 1 && d[0].name === "Fake.psd" && d[0].active === true, JSON.stringify(d));
});
await comCheck("DoJavaScript received debugger mode 1 (never show the debugger)", () => {
  const l = log("illustrator");
  assert(/call mode=1 /.test(l), l.slice(-300));
  return (/argsType=(\w+)/.exec(l) || [])[0];
});
await comCheck("values round-trip (objects, numbers, Unicode) through COM and UTF-8", async () => {
  const s = 'Ünïcödé ✓ — 日本語 "q" \\ back';
  const r = await es.runViaStdout("illustrator", `return { s: ${JSON.stringify(s)}, n: 3.5, list: [1, true, null], docs: app.documents.length };`);
  assert(r.ok && r.data.s === s && r.data.n === 3.5 && r.data.list.length === 3 && r.data.docs === 1, JSON.stringify(r));
});
await comCheck("an error thrown by the script comes back in the envelope", async () => {
  const r = await es.runViaStdout("photoshop", "throw new Error('no such layer');");
  assert(r.ok === false && /no such layer/.test(r.error), JSON.stringify(r));
  assert(incidents().pop()?.kind === "script-error", "no script-error incident");
});
// The incident log calls a failure a crash when the app's process is gone;
// these stand-ins live inside the helper, so there's no Illustrator.exe.
const loggedAs = (kinds) => {
  const last = incidents().pop();
  assert(last && kinds.includes(last.kind), "incident: " + JSON.stringify(last));
};
await comCheck("a COM-level failure reads as the app's script error (exit 6) and is logged", async () => {
  try {
    await es.runViaStdout("illustrator", "__FAKE_THROW__");
    throw new Error("resolved");
  } catch (e) {
    assert(/^Illustrator error \(COM\): /.test(e.message), e.message);
  }
  loggedAs(["app-error", "crash"]);
});
await comCheck("a script that doesn't parse comes back as an error with its message", async () => {
  const r = await es.runViaStdout("photoshop", "var = ;");
  assert(r.ok === false && r.error, JSON.stringify(r));
  return r.error;
});
await comCheck("a slow script times out with the Mac's message, and is logged", async () => {
  try {
    await es.runViaStdout("illustrator", "__FAKE_SLEEP_4000__", { timeoutMs: 1500 });
    throw new Error("resolved");
  } catch (e) {
    assert(/^Illustrator didn't answer in time/.test(e.message), e.message);
  }
  loggedAs(["timeout", "crash"]);
});
await comCheck("Stop ends a running script at once", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const t0 = Date.now();
  try {
    await es.runViaStdout("photoshop", "__FAKE_SLEEP_3000__", { signal: ac.signal, timeoutMs: 20000 });
    throw new Error("resolved");
  } catch (e) {
    assert(e.message === "stopped" && Date.now() - t0 < 2000, `${e.message} after ${Date.now() - t0} ms`);
  }
});

// ---------- After Effects: AfterFX.exe -r and dialogs ----------
console.log("After Effects: AfterFX.exe -r and dialogs");
await check("compile the After Effects stand-in (csc.exe)", () => {
  const exe = join(BIN, "AfterFX.exe");
  const r = spawnSync(cscPath(), ["/nologo", "/target:winexe", "/platform:anycpu", "/r:System.Windows.Forms.dll", "/r:System.Drawing.dll", `/out:${exe}`, join(ROOT, "packaging", "windows", "test", "FakeAdobe.cs")], { encoding: "utf8", windowsHide: true });
  assert(r.status === 0, r.stdout + r.stderr);
});
const fakeAe = spawn(join(BIN, "AfterFX.exe"), ["--dir", FAKE], { env: process.env, stdio: "ignore", detached: true });
fakeAe.unref();
await check("its main window is seen (a normal window, not a dialog)", async () => {
  for (let i = 0; i < 40; i++) {
    const m = await win.appWindows("aftereffects");
    const big = m && [...m.values()].find((w) => w.layer === 0 && w.w >= 800 && w.h >= 500);
    if (big) return `${big.w}x${big.h} "${big.title}"`;
    await sleep(250);
  }
  throw new Error("no main window");
});
let aeWorks = false;
await check("the -r handoff reaches it once AE has been up 15 s (60 s budget)", async () => {
  const r = await es.runViaFile("aftereffects", "return 1;", { timeoutMs: 30000 });
  assert(r && r.ok, JSON.stringify(r));
  aeWorks = true;
  return JSON.stringify(r.data);
});
if (!aeWorks) dumpLogs();
const aeCheck = (name, fn) => (aeWorks ? check(name, fn) : check(name, () => { throw new Error("skipped: the -r handoff doesn't work"); }));
await aeCheck("listDocuments through the -r handoff, with the UTF-8 BOM", async () => {
  const d = await ae.listDocuments();
  assert(d[0]?.name === "Fake Project.aep", JSON.stringify(d));
  assert(/bom=true/.test(log("aftereffects")), "the .jsx had no UTF-8 BOM");
});
await aeCheck("selection through the same handoff", async () => {
  const s = await ae.selection();
  assert(/Project "Fake Project"\. No comp is active/.test(s.summary), s.summary);
});
await aeCheck("a script error inside AE comes back in the envelope", async () => {
  const r = await es.runViaFile("aftereffects", "__FAKE_THROW__");
  assert(r.ok === false && /Error 21/.test(r.error), JSON.stringify(r));
});
for (const [kind, file] of [["custom modal window (owner disabled)", "dialog-form"], ["standard alert (#32770)", "dialog-box"]]) {
  await aeCheck(`${kind}: seen as a modal, and AE scripts are refused at once`, async () => {
    writeFileSync(join(FAKE, file), "");
    let modal = null;
    for (let i = 0; i < 40 && !modal; i++) {
      await sleep(250);
      const m = await win.appWindows("aftereffects");
      modal = m && [...m.values()].find((w) => w.layer === 8);
    }
    assert(modal, "no layer-8 window");
    assert(await dw.modalDialogUp("aftereffects"), "modalDialogUp false");
    const t0 = Date.now();
    try {
      await ae.listDocuments();
      throw new Error("resolved");
    } catch (e) {
      assert(e.code === "AE_DIALOG" && Date.now() - t0 < 8000, `${e.code}: ${e.message}`);
    }
    rmSync(join(FAKE, file), { force: true });
    for (let i = 0; i < 40 && (await dw.modalDialogUp("aftereffects")); i++) await sleep(250);
    const d = await ae.listDocuments();
    assert(d[0]?.name === "Fake Project.aep", "after closing: " + JSON.stringify(d));
    return `${modal.w}x${modal.h} "${modal.title}"`;
  });
}
await aeCheck("the dialog notice: a hint while a dialog is up, cleared when it closes", async () => {
  const seen = [];
  const stop = dw.watchForDialog("aftereffects", (t) => seen.push(t), { startAfterMs: 500, everyMs: 400 });
  await sleep(800);
  writeFileSync(join(FAKE, "dialog-form"), "");
  for (let i = 0; i < 40 && !seen.some(Boolean); i++) await sleep(250);
  rmSync(join(FAKE, "dialog-form"), { force: true });
  for (let i = 0; i < 40 && seen[seen.length - 1] !== null; i++) await sleep(250);
  stop();
  assert(seen.some((t) => /After Effects seems to be showing a dialog/.test(t || "")), JSON.stringify(seen));
  assert(seen[seen.length - 1] === null, "not cleared: " + JSON.stringify(seen));
});
await aeCheck("a slow AE script times out with the Mac's message", async () => {
  try {
    await es.runViaFile("aftereffects", "__FAKE_SLEEP_3000__", { timeoutMs: 1000 });
    throw new Error("resolved");
  } catch (e) {
    assert(/After Effects didn't answer in time/.test(e.message), e.message);
  }
  await sleep(3000);
});

// ---------- clean up ----------
spawnSync("taskkill", ["/IM", "AfterFX.exe", "/F"], { windowsHide: true });
for (const app of ["illustrator", "photoshop"]) regsvr(["/s", "/n", "/u", `/i:${wscPath(app)}`, "scrobj.dll"]);
const failed = results.filter((r) => !r.ok);
if (failed.length) dumpLogs();
try {
  mkdirSync(join(ROOT, "dist", "windows"), { recursive: true });
  cpSync(FAKE, join(ROOT, "dist", "windows", "fake-logs"), { recursive: true, filter: (p) => !p.includes("inbox") });
  writeFileSync(join(ROOT, "dist", "windows", "fake-adobe.json"), JSON.stringify(results, null, 2));
} catch {}
await sleep(500);
rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} FAILED` : ""}`);
process.exit(failed.length ? 1 : 0);
