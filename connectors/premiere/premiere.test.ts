// Premiere Pro end to end without Premiere: the REAL panel (panel/bridge.js) runs under a
// stand-in CEP host and runs every script it gets, as sent, against a small made-up Premiere
// with two projects open ("Show.prproj", active, and "Client.prproj", the person's other
// work). So the door, the token, the envelope, the guard that keeps changes in the named
// active project, the K toolkit, renders, contact sheets, exports and saves are all tested
// on every system the tests run on. What the real Premiere does with each call was checked
// live on Premiere Pro 26.5 for 1.0; the guard, saving a copy or as, and the panel's new
// address are new here and wait for a live run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import type { DocRef } from "../../protocol/common.ts";
import type { Connector } from "../../protocol/connector.ts";
import { createKit } from "../_kit/adobe.ts";
import type { ConnectorOptions } from "../_kit/adobe.ts";
import { wrap } from "../_kit/envelope.ts";
import { createFakeTransport } from "../_kit/fake.ts";
import type { FakeTransportOptions } from "../_kit/fake.ts";
import type { Incident } from "../_kit/incidents.ts";
import { loadConnectors } from "../index.ts";
import { createPremiere, MAX_WATCH } from "./index.ts";
import { CSXS_VERSIONS, PANEL_ID, PANEL_SOURCE, cepExtensionsDir, installPremierePanel, panelAddressFile, premierePanelState, removePremierePanel } from "./install.ts";
import type { DebugModeSwitch } from "./install.ts";
import { maskCode, refuseScript } from "./scriptcheck.ts";
import * as S from "./scripts.ts";
import { contactSheets, decodePng, encodePng, grid, shrink, smallerPng } from "./sheets.ts";
import { runIn, standInPremiere, startStandInPanel, Time, TPS } from "./standin.ts";
import type { StandInPanel, StandInPremiere } from "./standin.ts";
import { summarizeSelection } from "./summary.ts";
import { K_HELPERS, K_LIB } from "./toolkit.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const made: string[] = [];
process.once("exit", () => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };

const SHOW = (pr: StandInPremiere): DocRef => ({ app: "premiere", name: "Show.prproj", path: pr.show.path });
const CLIENT = (pr: StandInPremiere): DocRef => ({ app: "premiere", name: "Client.prproj", path: pr.client.path });

function fakeDebugMode(on = true): DebugModeSwitch & { writes: boolean[] } {
  const writes: boolean[] = [];
  return { writes, read: async () => on, write: async (v) => { writes.push(v); } };
}

interface Rig {
  dir: string;
  home: string;
  pr: StandInPremiere;
  panel: StandInPanel | null;
  c: Connector;
  incidents: Incident[];
  extensionsDir: string;
  done(): Promise<void>;
}

// A connector with the made-up Premiere behind the real panel.
async function rig(o: { panel?: boolean; evalScript?: (s: string) => string | null; fake?: FakeTransportOptions; kit?: ConnectorOptions; debugMode?: boolean; install?: boolean } = {}): Promise<Rig> {
  const dir = tmp("kp-pr-");
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const pr = standInPremiere({ dir: join(dir, "premiere") });
  const extensionsDir = join(home, "Library", "Application Support", "Adobe", "CEP", "extensions");
  if (o.install) await installPremierePanel({ platform: "mac", extensionsDir, debugMode: fakeDebugMode() });
  const panel = o.panel === false ? null : await startStandInPanel({ home, evalScript: o.evalScript ?? runIn(pr) });
  const incidents: Incident[] = [];
  const transport = createFakeTransport({ running: { premiere: true }, ...o.fake });
  const kit = createKit("mac", { transport, scratchDir: join(dir, "scratch"), home, onIncident: (i) => incidents.push(i), ...o.kit });
  const c = createPremiere(kit, { home, extensionsDir, debugMode: fakeDebugMode(o.debugMode ?? true) });
  return { dir, home, pr, panel, c, incidents, extensionsDir, done: async () => { await panel?.stop(); } };
}

const sent = (r: Rig) => r.panel!.scripts.length;

// ---------- the manifest and loading ----------

test("loadConnectors: Premiere Pro beside the three scripting apps, through its own panel", () => {
  const m = loadConnectors("mac", { transport: createFakeTransport(), scratchDir: tmp("kp-pr-load-") });
  assert.deepEqual([...m.keys()], ["illustrator", "photoshop", "aftereffects", "premiere"]);
  const p = m.get("premiere")!.manifest;
  assert.equal(p.label, "Premiere Pro");
  assert.equal(p.door, "in-app-plugin");
  assert.equal(p.language, "extendscript");
  assert.deepEqual(p.platforms, ["mac", "win"]);
  assert.deepEqual(p.capabilities.export, ["png", "mp4"]);
  assert.deepEqual(p.capabilities.save, ["overwrite", "copy", "as"]);
  for (const k of ["inspect", "run", "render", "undo", "selection", "place", "open"] as const) assert.equal(p.capabilities[k], true, k);
  assert.ok(!p.capabilities.newDocument, "no new document: it couldn't name the project it writes into");
  assert.ok(!p.capabilities.dialog && !p.capabilities.singleDocument && !p.capabilities.preflight);
  assert.deepEqual(p.heavy, ["render", "export", "inspect"], "inspect draws a picture too");
  assert.equal(loadConnectors("win", { transport: createFakeTransport({ platform: "win" }) }).size, 4);
});

// ---------- the panel itself ----------

test("the panel: its address in Komposit's data folder (this user only), a token on every request, web pages and other host names refused", async () => {
  const home = tmp("kp-pr-panel-");
  const pr = standInPremiere({ dir: join(home, "premiere") });
  const panel = await startStandInPanel({ home, evalScript: runIn(pr) });
  try {
    assert.equal(panel.file, panelAddressFile({ platform: "mac", home }), "the panel and the connector agree on where the address is");
    assert.ok(panel.file.includes(join("Application Support", "dev.werq.komposit")));
    assert.ok(!/Application Support\/Komposit\//.test(panel.file), "never 1.0's folder");
    // Windows has no Unix modes (Node reports 0o666); there the folder in %APPDATA% is the person's own.
    if (process.platform !== "win32") assert.equal(statSync(panel.file).mode & 0o777, 0o600);
    const info = JSON.parse(readFileSync(panel.file, "utf8"));
    assert.match(info.token, /^[a-f0-9]{48}$/);
    assert.equal(info.bridge, "0.1.0");
    assert.deepEqual(info.host, { appName: "PPRO", appVersion: "26.5.3" });
    const at = (path: string, headers: Record<string, string>, body?: string) =>
      fetch(`http://127.0.0.1:${panel.port}${path}`, { method: body ? "POST" : "GET", headers, ...(body ? { body } : {}) }).then(async (r) => ({ status: r.status, json: (await r.json()) as { bridge?: string; result: string } }));
    assert.equal((await at("/status", {})).status, 401, "no token");
    assert.equal((await at("/status", { "x-komposit-token": "0".repeat(48) })).status, 401, "wrong token");
    const ok = await at("/status", { "x-komposit-token": panel.token });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.bridge, "0.1.0");
    assert.equal(panel.scripts.length, 0, "status never reaches Premiere's scripting");
    assert.equal((await at("/status", { "x-komposit-token": panel.token, origin: "https://example.com" })).status, 403, "a web page");
    const rebinding = await new Promise<number>((resolve) => {
      import("node:http").then(({ request }) => {
        const req = request({ host: "127.0.0.1", port: panel.port, path: "/status", headers: { host: `evil.example:${panel.port}`, "x-komposit-token": panel.token } }, (res) => { res.resume(); resolve(res.statusCode || 0); });
        req.end();
      });
    });
    assert.equal(rebinding, 403, "another host name (DNS rebinding)");
    const ran = await at("/eval", { "x-komposit-token": panel.token, "content-type": "application/json" }, JSON.stringify({ script: wrap("return app.project.name;", { viaEval: true }) }));
    assert.equal(ran.status, 200);
    assert.deepEqual(JSON.parse(ran.json.result).data, "Show.prproj");
    assert.equal((await at("/eval", { "x-komposit-token": panel.token, "content-type": "application/json" }, "{")).status, 400);
  } finally {
    await panel.stop();
  }
  assert.ok(!existsSync(panel.file), "Premiere closing the panel takes its address away");
});

test("the panel's files: Komposit's extension id, hidden, started with Premiere, CEP 9 and later", () => {
  const xml = readFileSync(join(PANEL_SOURCE, "CSXS", "manifest.xml"), "utf8");
  assert.match(xml, /ExtensionBundleId="dev\.werq\.komposit\.premiere"/);
  assert.match(xml, /<Extension Id="dev\.werq\.komposit\.premiere\.bridge"/);
  assert.match(xml, /ExtensionBundleName="Komposit"/);
  assert.equal(PANEL_ID, "dev.werq.komposit.premiere");
  assert.match(xml, /<Host Name="PPRO" Version="\[14\.0,99\.9\]"/);
  assert.match(xml, /<AutoVisible>false<\/AutoVisible>/);
  assert.match(xml, /--enable-nodejs/);
  const js = readFileSync(join(PANEL_SOURCE, "bridge.js"), "utf8");
  assert.match(js, /var FOLDER = "dev.werq.komposit";/);
  assert.match(js, /"premiere-panel\.json"/);
  assert.ok(!/premiere-bridge\.json|"Komposit"\)/.test(maskCode(js).code), "nothing of 1.0's folder or file (outside the comments that name them)");
  assert.match(js, /server\.setTimeout\(0\)/, "a long export keeps its line open");
  assert.ok(panelAddressFile({ platform: "win", env: { APPDATA: "C:\\Users\\ana\\AppData\\Roaming" } }).endsWith("Roaming\\dev.werq.komposit\\premiere-panel.json"));
  assert.equal(cepExtensionsDir({ platform: "win", env: { APPDATA: "C:\\Users\\ana\\AppData\\Roaming" } }), "C:\\Users\\ana\\AppData\\Roaming\\Adobe\\CEP\\extensions");
});

// ---------- status ----------

test("status: one plain sentence for each reason it can't work, and nothing sent to Premiere's scripting", async () => {
  const cases: [string, Parameters<typeof rig>[0], RegExp][] = [
    ["not installed", { panel: false, fake: { running: { premiere: false }, installed: { premiere: null } } }, /^Premiere Pro isn't installed on this Mac\.$/],
    ["not open", { panel: false, fake: { running: { premiere: false } } }, /^Premiere Pro isn't open\.$/],
    ["no panel", { panel: false }, /^Komposit's panel isn't installed in Premiere Pro yet, so Komposit can't reach it\.$/],
    ["unsigned panels off", { panel: false, install: true, debugMode: false }, /^Premiere Pro won't load Komposit's panel until unsigned panels are allowed: install the panel again, then quit and reopen Premiere Pro\.$/],
    ["just started", { panel: false, install: true, fake: { uptime: 20 } }, /^Premiere Pro is still starting; Komposit's panel loads a few seconds after it opens\.$/],
    ["not loaded", { panel: false, install: true }, /^Premiere Pro hasn't loaded Komposit's panel: quit and reopen Premiere Pro once\.$/],
  ];
  for (const [what, o, reason] of cases) {
    const r = await rig(o);
    try {
      const s = await r.c.status();
      assert.equal(s.ready, false, what);
      assert.match(s.reason || "", reason, what);
      assert.equal(s.reason!.split(/(?<=\.)\s/).length, 1, `${what}: one sentence`);
    } finally {
      await r.done();
    }
  }
  // An older copy of the panel.
  const old = await rig({ panel: false, install: true });
  const xml = join(old.extensionsDir, PANEL_ID, "CSXS", "manifest.xml");
  writeFileSync(xml, readFileSync(xml, "utf8").replace('ExtensionBundleVersion="0.1.0"', 'ExtensionBundleVersion="0.0.9"'));
  assert.match((await old.c.status()).reason || "", /^Komposit's panel in Premiere Pro is out of date: install it again, then quit and reopen Premiere Pro\.$/);
  await old.done();

  const r = await rig();
  try {
    const s = await r.c.status();
    assert.deepEqual(s, { app: "premiere", label: "Premiere Pro", installed: true, running: true, ready: true, version: "26.5.3" });
    assert.equal(sent(r), 0, "status asks the panel, not Premiere");
  } finally {
    await r.done();
  }
});

// ---------- reading ----------

test("documents: the open projects with their sequences, the active one marked", async () => {
  const r = await rig();
  try {
    const docs = await r.c.documents();
    assert.deepEqual(docs, [
      { app: "premiere", name: "Show.prproj", path: r.pr.show.path, active: true, sequences: ["Podcast"], part: { id: "seq-doc-1", name: "Podcast" } },
      { app: "premiere", name: "Client.prproj", path: r.pr.client.path, active: false, sequences: ["Cut 3"] },
    ]);
    assert.deepEqual(r.pr.log, [], "reading changed nothing");
  } finally {
    await r.done();
  }
});

test("inspect and selection: the project map with refs, a picture of the frame at the playhead, the selected clips", async () => {
  const r = await rig({ kit: { renderMaxPx: 160 } });
  try {
    const i = await r.c.inspect(SHOW(r.pr));
    const d = JSON.parse(i.text);
    assert.equal(d.project, "Show.prproj");
    assert.equal(d.appVersion, "26.5.3");
    assert.deepEqual(d.sequences, ["Podcast"]);
    assert.equal(d.sequence.name, "Podcast");
    assert.equal(d.sequence.fps, 25);
    assert.equal(d.sequence.duration, 20);
    assert.equal(d.sequence.video[1].clips[1].ref, "seq.videoTracks[1].clips[1]");
    assert.deepEqual(d.sequence.markers, [{ start: 2, name: "intro" }]);
    assert.ok(i.picture && i.picture.mime === "image/png");
    assert.equal(i.picture.width, 160, "shrunk to the render size");
    assert.equal(i.picture.height, 90);
    const sel = await r.c.selection!(SHOW(r.pr));
    assert.match(sel.summary, /^Sequence "Podcast" \(320×180, 25 fps, 20 s\), playhead at 5 s\.\n1 clip selected on the timeline:\n- video clip "host cam\.mp4" 0-8 s\. ref: seq\.videoTracks\[1\]\.clips\[0\]$/);
    // The person's other project, named while it isn't the active one: a plain refusal.
    await assert.rejects(r.c.inspect(CLIENT(r.pr)), /^Error: Client\.prproj is open in Premiere Pro, but the active project is Show\.prproj, and Premiere only takes scripts in its active project, so nothing ran\./);
    assert.deepEqual(r.pr.log.filter((l) => !l.startsWith("exportFramePNG")), [], "reading changed nothing");
    assert.deepEqual(readdirSync(join(r.dir, "scratch")), [], "no scratch files left");
  } finally {
    await r.done();
  }
});

// ---------- edits and the guard ----------

test("edits: the K toolkit on the edit's own first line; results, logs and errors come back", async () => {
  const r = await rig();
  try {
    const ok = await r.c.run("log('hi'); return { name: K.seq().name, snapped: K.snap(1.01), merged: K.mergeRanges([[3, 4], [1, 2], [1.5, 3.2]], 0) };", SHOW(r.pr));
    assert.deepEqual(ok, { ok: true, result: { name: "Podcast", snapped: 1, merged: [[1, 4]] }, logs: ["hi"] });
    const bad = await r.c.run("var x = 1;\nreturn K.clip('video', 9, 0);", SHOW(r.pr));
    assert.equal(bad.ok, false);
    // (Premiere adds the line, " (line 2)"; the stand-in's JavaScript doesn't.)
    assert.match(bad.error!, /^No video track 10 \(there are 3\)\.( \(line \d+\))?$/);
    const sentScript = r.panel!.scripts[0]!;
    assert.ok(sentScript.includes(JSON.stringify(K_LIB.slice(0, 40)).slice(1, -1)), "the toolkit went with it");
    // A dialog the script asks for is never shown.
    const quiet = await r.c.run("alert('stop!'); return confirm('sure?');", SHOW(r.pr));
    assert.deepEqual(quiet, { ok: true, result: false, logs: ["Not shown (alert): stop!", "Not shown (confirm, answered no): sure?"] });
    assert.ok(r.incidents.some((i) => i.kind === "script-error" && /No video track 10/.test(i.message)));
  } finally {
    await r.done();
  }
});

test("the guard: an edit runs only in the project it names, and only while that's the active one; otherwise nothing changes", async () => {
  const r = await rig();
  try {
    const touch = "app.project.rootItem.createBin('Komposit test'); return app.project.name;";
    const before = sent(r);
    const none = await r.c.run(touch, undefined);
    assert.equal(none.ok, false);
    assert.equal(none.error, "An edit in Premiere Pro needs the project named: pass doc with its name and path, as the open-files list (or documents) gives them, so nothing lands in another project. Nothing ran.");
    assert.equal(sent(r), before, "nothing was sent");

    const other = await r.c.run(touch, CLIENT(r.pr));
    assert.equal(other.ok, false);
    assert.equal(other.error, "Client.prproj is open in Premiere Pro, but the active project is Show.prproj, and Premiere only takes scripts in its active project, so nothing ran. Ask the person to click into Client.prproj in Premiere Pro (or name Show.prproj if that is the one to work in).");
    const unknown = await r.c.run(touch, { app: "premiere", name: "Elsewhere.prproj", path: "/nowhere/Elsewhere.prproj" });
    assert.equal(unknown.error, "No open Premiere Pro project is /nowhere/Elsewhere.prproj (open: Show.prproj (active), Client.prproj), so nothing ran.");
    assert.deepEqual(r.pr.log, [], "neither project was touched");

    // By name alone, when the name is unique; by path when two open projects share it.
    assert.deepEqual(await r.c.run(touch, { app: "premiere", name: "Show" }), { ok: true, result: "Show.prproj", logs: [] });
    r.pr.client.name = "Show.prproj";
    const twin = await r.c.run("return 1;", { app: "premiere", name: "Show.prproj" });
    assert.equal(twin.error, "Two open Premiere Pro projects are called Show.prproj: pass its path too, so the right one is used. Nothing ran.");
    assert.equal((await r.c.run("return 1;", SHOW(r.pr))).ok, true);
    assert.ok(r.incidents.some((i) => i.kind === "blocked" && i.code === "NOT_TARGET"));

    // The person switches projects between two calls: the next call names the old one and stops.
    r.pr.client.name = "Client.prproj";
    r.pr.app._active = r.pr.client;
    const switched = await r.c.run(touch, SHOW(r.pr));
    assert.match(switched.error!, /^Show\.prproj is open in Premiere Pro, but the active project is Client\.prproj/);
    assert.equal(r.pr.client.rootItem.children.length, 2, "the person's project got nothing");
    assert.deepEqual(r.pr.log, ["createBin:Komposit test"], "only the one edit that named the active project");
  } finally {
    await r.done();
  }
});

test("edits that save, open, close or switch projects, quit, or reach into other projects are refused before anything is sent", async () => {
  const r = await rig();
  try {
    const before = sent(r);
    for (const code of [
      "app.project.save();",
      "var p = app.project; p.saveAs('/tmp/x.prproj');",
      "app.project['save']();",
      "app.openDocument('/tmp/other.prproj');",
      "app.project.closeDocument(0, 0);",
      "app.quit();",
      "var o = app.projects[1]; o.rootItem.createBin('x');",
      'app["projects"][0].name;',
      "app.newProject('/tmp/n.prproj');",
    ]) {
      const res = await r.c.run(code, SHOW(r.pr));
      assert.equal(res.ok, false, code);
      assert.match(res.error!, /^edit didn't run, so nothing changed: this script /, code);
    }
    assert.equal(sent(r), before, "none of them reached Premiere");
    assert.deepEqual(r.pr.log, []);
    // Words in comments and strings aren't code.
    assert.equal(refuseScript("// never call app.project.save() here\nlog('save() is the save tool'); return app.project.name;"), null);
    assert.equal(refuseScript("var s = app.project.activeSequence; /* app.projects */ return s.name;"), null);
    assert.match(refuseScript("app.project.save(); app.quit();")!, /saves the project, and quits Premiere Pro/);
    assert.equal(maskCode("a('x.save()')").bare, "a('" + " ".repeat(8) + "')");
  } finally {
    await r.done();
  }
});

// ---------- renders ----------

test("render: the frame at the playhead, frames across the in/out range, the middle one as the picture; scratch files go", async () => {
  const r = await rig({ kit: { renderMaxPx: 100 } });
  try {
    const one = await r.c.render(SHOW(r.pr));
    assert.equal(one.note, 'the frame at the playhead (5 s) of "Podcast"');
    assert.equal(one.picture!.width, 100);
    assert.ok(!one.pictures);
    r.pr.show.activeSequence.setInPoint(4);
    r.pr.show.activeSequence.setOutPoint(10);
    const three = await r.c.render(SHOW(r.pr), { frames: 3 });
    assert.equal(three.note, '3 frames of "Podcast" at 5, 7, 9 s');
    assert.equal(three.pictures!.length, 3);
    assert.equal(three.picture, three.pictures![1], "the middle one");
    // Each frame is its own time (the stand-in colors frames by time).
    const reds = three.pictures!.map((p) => decodePng(p.bytes).rgb[0]);
    assert.deepEqual(reds, [60, 84, 108]);
    assert.ok(!three.videoPath);
    assert.deepEqual(readdirSync(join(r.dir, "scratch")), []);
  } finally {
    await r.done();
  }
});

test("render, watching a stretch: contact sheets with each frame's time, the cuts marked, and which clip and source second every frame is", async () => {
  const r = await rig();
  try {
    const w = await r.c.render(SHOW(r.pr), { every: 1, from: 6, to: 12 } as any);
    assert.equal(w.pictures!.length, 1);
    assert.equal(w.picture, w.pictures![0]);
    const sheet = decodePng(w.picture!.bytes);
    const g = grid(300, 169);
    assert.ok(sheet.w <= 1500 && sheet.h <= 1320, "one sheet fits the limits");
    assert.ok(g.per >= 6);
    assert.match(w.note!, /^6 frames, one every 1 s from 6 to 11 s of "Podcast", on 1 contact sheet \(read left to right/);
    assert.match(w.note!, /\nWhere each frame comes from:\nV2 clip 0 "host cam\.mp4" \(on the timeline 0–8 s; these frames are its source at 6–7 s\): 6, 7\nV2 clip 1 "guest cam\.mp4" \(on the timeline 8–20 s; these frames are its source at 0–3 s\): 8, 9, 10, 11$/);
    // More than fits one call: it says where to carry on.
    const long = await r.c.render(SHOW(r.pr), { every: 0.1, from: 0, to: 20 } as any);
    assert.match(long.note!, new RegExp(`^${MAX_WATCH} frames, one every 0\\.1 s from 0 to 9\\.5 s`));
    assert.match(long.note!, /The stretch goes on: watch again from 9\.6 to see the rest\.$/);
    assert.ok(long.pictures!.length >= 3, "several sheets");
    await assert.rejects(r.c.render(SHOW(r.pr), { from: 30, to: 40 } as any), /Nothing to watch between 30 and 20 s/);
    // Frames this can't read (here: interlaced) say so, and how to look instead.
    const interlaced = (png: Uint8Array) => { const b = Uint8Array.from(png); b[28] = 1; return b; };
    const orig = r.pr.qe.project.getActiveSequence;
    r.pr.qe.project.getActiveSequence = () => { const q = orig(); const ex = q.exportFramePNG; return { ...q, exportFramePNG: (tc: string, out: string) => { ex(tc, out); setTimeout(() => writeFileSync(out, interlaced(readFileSync(out))), 60); return true; } }; };
    await assert.rejects(r.c.render(SHOW(r.pr), { every: 1, from: 1, to: 3 } as any), /Komposit couldn't read Premiere Pro's frames to make contact sheets \(.*\)\. Look with frames 2-8 instead\./);
    r.pr.qe.project.getActiveSequence = orig;
    assert.deepEqual(readdirSync(join(r.dir, "scratch")), []);
  } finally {
    await r.done();
  }
});

test("frames don't pop up Premiere's Events pop-up: the setting is off for the session while they come in, then put back; one already off is left alone; frames come even if it can't be changed", async () => {
  const KEY = S.EVENTS_KEY;
  const r = await rig({ kit: { renderMaxPx: 100 } });
  try {
    await r.c.render(SHOW(r.pr), { frames: 3 });
    await r.c.render(SHOW(r.pr), { every: 1, from: 6, to: 9 } as any);
    const png = await r.c.exportCopy({ format: "png" });
    assert.equal(png.ok, true, png.error);
    assert.equal(r.pr.popups(), 0, "no pop-ups for Komposit's frames");
    assert.equal(r.pr.prefs[KEY], "true", "the person's setting is back");
    assert.deepEqual(r.pr.prefLog, [`${KEY}=false (this session)`, `${KEY}=true`, `${KEY}=false (this session)`, `${KEY}=true`, `${KEY}=false (this session)`, `${KEY}=true`]);
    // The person turned it off themselves: nothing touches it.
    r.pr.prefs[KEY] = "false";
    r.pr.prefLog.length = 0;
    await r.c.render(SHOW(r.pr));
    assert.deepEqual(r.pr.prefLog, []);
    assert.equal(r.pr.prefs[KEY], "false");
    // Preferences out of reach: the frames come all the same (with Premiere's pop-ups).
    r.pr.prefs[KEY] = "true";
    const props = r.pr.app.properties;
    r.pr.app.properties = { ...props, setProperty: () => { throw new Error("no"); } };
    const one = await r.c.render(SHOW(r.pr));
    assert.ok(one.picture);
    assert.ok(r.pr.popups() > 0);
    r.pr.app.properties = props;
    assert.deepEqual(readdirSync(join(r.dir, "scratch")), []);
  } finally {
    await r.done();
  }
});

test("render with video: only with the project named; the in and out points are put back", async () => {
  const r = await rig();
  try {
    const no = await r.c.render(undefined, { video: true });
    assert.ok(!no.videoPath);
    assert.match(no.note!, /No preview video: making one sets the sequence's in and out points for a moment, so it needs the project named \(pass doc\)$/);
    assert.ok(!r.pr.log.some((l) => l.startsWith("setInPoint")));
    const [inT, outT] = r.pr.show.activeSequence._inOut();
    const v = await r.c.render(SHOW(r.pr), { video: true });
    assert.ok(v.videoPath && existsSync(v.videoPath));
    assert.match(v.note!, /; a preview video of up to 10 s around the playhead \(low bitrate\)$/);
    assert.ok(r.pr.log.includes("exportAsMediaDirect:01 - Match Source - Low bitrate.epr:1:in=5:out=15"), r.pr.log.join("\n"));
    assert.deepEqual(r.pr.show.activeSequence._inOut(), [inT, outT], "put back as they were");
    const elsewhere = await r.c.render(CLIENT(r.pr), { video: true }).catch((e) => e);
    assert.match(String(elsewhere), /Client\.prproj is open in Premiere Pro, but the active project is Show\.prproj/);
  } finally {
    await r.done();
  }
});

// ---------- exports ----------

test("export: png of the frame at the playhead at full size, mp4 of the sequence; a new file every time; the project untouched", async () => {
  const r = await rig({ kit: { renderMaxPx: 100 } });
  try {
    const out = join(r.home, "Komposit Exports");
    const png = await r.c.exportCopy({ format: "png" });
    assert.equal(png.ok, true, png.error);
    assert.equal(png.path, join(out, "Podcast.png"), "named after the sequence");
    assert.deepEqual([decodePng(readFileSync(png.path!)).w, decodePng(readFileSync(png.path!)).h], [320, 180], "full size");
    assert.equal(png.sourceUnchanged, true);
    const again = await r.c.exportCopy({ format: "png", name: "Podcast" });
    assert.equal(again.path, join(out, "Podcast 2.png"), "never over the first");
    const mp4 = await r.c.exportCopy({ format: "mp4", name: "cut" });
    assert.equal(mp4.ok, true, mp4.error);
    assert.equal(mp4.path, join(out, "cut.mp4"));
    assert.match(mp4.note!, /^H\.264 MP4 of the entire sequence of "Podcast", 320×180, matching the sequence's settings \(preset 01 - Match Source - Medium bitrate\.epr\)\.$/);
    r.pr.show.activeSequence.setInPoint(2);
    r.pr.show.activeSequence.setOutPoint(6);
    const ranged = await r.c.exportCopy({ format: "mp4", name: "cut" });
    assert.equal(ranged.path, join(out, "cut 2.mp4"));
    assert.match(ranged.note!, /of the in to out of "Podcast"/);
    assert.ok(r.pr.log.includes("exportAsMediaDirect:01 - Match Source - Medium bitrate.epr:1:in=2:out=6"));
    assert.ok(!r.pr.log.some((l) => /^(save|saveAs|createBin|importFiles)/.test(l)), "the project wasn't changed");
    const jpg = await r.c.exportCopy({ format: "jpg" });
    assert.equal(jpg.ok, false);
    assert.match(jpg.error!, /can export png \(the frame at the playhead\) and mp4 \(the sequence\); not "jpg"/);
    const outside = await r.c.exportCopy({ format: "png", outputDir: "/etc" });
    assert.match(outside.error!, /only writes inside your home folder or a project's folder/);
  } finally {
    await r.done();
  }
});

// ---------- saving ----------

test("save: only the named, active project, only when called; overwrite, a copy that leaves the project as it is, and save as; never over a file", async () => {
  const r = await rig();
  try {
    const none = await r.c.save({ mode: "overwrite" });
    assert.equal(none.ok, false);
    assert.match(none.error!, /^Saving in Premiere Pro needs the project named/);
    const other = await r.c.save({ doc: CLIENT(r.pr), mode: "overwrite" });
    assert.equal(other.ok, false);
    assert.match(other.error!, /^Client\.prproj is open in Premiere Pro, but the active project is Show\.prproj/);
    assert.deepEqual(r.pr.log, [], "nothing saved");

    const saved = await r.c.save({ doc: SHOW(r.pr), mode: "overwrite" });
    assert.deepEqual(saved, { ok: true, path: r.pr.show.path, note: 'Saved the project "Show.prproj".', warnings: [] });
    assert.deepEqual(r.pr.log, ["save:Show.prproj"], "that project only");

    const dir = join(r.home, "Komposit Exports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Show copy.prproj"), "someone's file");
    const copy = await r.c.save({ doc: SHOW(r.pr), mode: "copy", name: "Show copy", outputDir: dir });
    assert.equal(copy.ok, true, copy.error);
    assert.equal(copy.path, join(dir, "Show copy 2.prproj"), "never over a file that's there");
    assert.equal(readFileSync(join(dir, "Show copy.prproj"), "utf8"), "someone's file");
    assert.equal(copy.sourceUnchanged, true);
    assert.match(copy.note!, /^A new project with the sequence "Podcast" and the media it uses \(other sequences aren't in it\)\. The open project "Show\.prproj" is unchanged/);
    assert.equal(r.pr.app.project.path, join(r.pr.dirs.projDir, "Show.prproj"), "the open project is still the person's file");

    const as = await r.c.save({ doc: SHOW(r.pr), mode: "as", name: "Show v2", outputDir: dir });
    assert.equal(as.ok, true, as.error);
    assert.equal(as.path, join(dir, "Show v2.prproj"));
    assert.match(as.note!, /The open project is now that file, so later saves go there/);
    assert.equal(r.pr.app.project.path, join(dir, "Show v2.prproj"));
    // From now on the project is the new file: the old name and path no longer match.
    const stale = await r.c.run("return 1;", { app: "premiere", name: "Show.prproj", path: join(r.pr.dirs.projDir, "Show.prproj") });
    assert.match(stale.error!, /^No open Premiere Pro project is .*Show\.prproj/);
    assert.equal((await r.c.run("return 1;", { app: "premiere", name: "Show v2.prproj", path: as.path! })).ok, true);
    assert.deepEqual(r.pr.log, ["save:Show.prproj", "exportAsProject:Podcast", "saveAs:Show.prproj->Show v2.prproj"]);
    assert.ok(!(r.pr.log as string[]).includes("save:Client.prproj"), "the person's other project was never saved");
    const bad = await r.c.save({ doc: { app: "premiere", name: "Show v2.prproj", path: as.path! }, mode: "zip" });
    assert.match(bad.error!, /saves overwrite, copy or as; not "zip"/);
  } finally {
    await r.done();
  }
});

// ---------- undo, place, open ----------

test("undo: only with the project named; Premiere's QE undo, step by step", async () => {
  const r = await rig();
  try {
    const none = await r.c.undo(undefined, 1);
    assert.equal(none.ok, false);
    assert.match(none.error!, /^Undo in Premiere Pro needs the project named/);
    assert.equal(r.pr.undos(), 0);
    assert.deepEqual(await r.c.undo(SHOW(r.pr), 2), { ok: true, result: 2, logs: [] });
    assert.equal(r.pr.undos(), 2);
    assert.equal((await r.c.undo(CLIENT(r.pr), 1)).ok, false);
    assert.equal(r.pr.undos(), 2, "nothing undone in a project that isn't active");
  } finally {
    await r.done();
  }
});

test("place and open: a file into the named project's Komposit bin and onto a free track; projects open, and an open one that isn't active says so", async () => {
  const r = await rig();
  try {
    const title = join(r.pr.dirs.mediaDir, "title.png");
    writeFileSync(title, encodePng(new Uint8Array(4 * 4 * 3), 4, 4));
    const none = await r.c.place!({ file: title });
    assert.match(none.error!, /^Placing a file in Premiere Pro needs the project named/);
    const placed = await r.c.place!({ file: title, into: SHOW(r.pr) });
    assert.equal(placed.ok, true, placed.error);
    assert.equal(placed.note, 'Imported title.png into the project "Show.prproj" (bin "Komposit") and put it on V3 of "Podcast" at 5 s.');
    assert.deepEqual(r.pr.log, ["createBin:Komposit", "importFiles:title.png:Komposit", "overwriteClip:Video 3:title.png@5"]);
    const only = await r.c.place!({ file: title, into: SHOW(r.pr), addToSequence: false } as any);
    assert.match(only.note!, /^Imported title\.png into the project "Show\.prproj" \(bin "Komposit"\)\.$/);
    assert.equal((await r.c.place!({ file: "/nope.png", into: SHOW(r.pr) })).ok, false);

    await assert.rejects(r.c.open!(title), /opens projects \(\.prproj\)/);
    await assert.rejects(r.c.open!(r.pr.client.path), /^Error: Client\.prproj is already open in Premiere Pro, but it isn't the active project/);
    assert.deepEqual(await r.c.open!(r.pr.show.path), { app: "premiere", name: "Show.prproj", path: r.pr.show.path });
    const other = join(dirname(r.pr.dirs.projDir), "Other.prproj");
    writeFileSync(other, "fake prproj");
    const opened = await r.c.open!(other);
    assert.equal(opened.name, "Other.prproj");
    assert.equal(r.pr.app.project.name, "Other.prproj", "the project it opened is the active one");
  } finally {
    await r.done();
  }
});

// ---------- when the panel can't be reached ----------

test("the panel can't be reached: Premiere quit, a stale token, a script that never comes back, a line that drops, an EvalScript error: each a plain sentence", async () => {
  // Premiere quit: the address file stays behind (no unload), nothing listens there.
  const r = await rig({ install: true });
  const stale = readFileSync(r.panel!.file, "utf8");
  await r.panel!.stop();
  writeFileSync(r.panel!.file, stale);
  const gone = await r.c.run("return 1;", SHOW(r.pr));
  assert.deepEqual(gone, { ok: false, error: "Premiere Pro hasn't loaded Komposit's panel: quit and reopen Premiere Pro once.", logs: [] });
  await assert.rejects(r.c.documents(), /^Error: Premiere Pro hasn't loaded Komposit's panel/);

  // A token from an older run.
  const t = await rig();
  const info = JSON.parse(readFileSync(t.panel!.file, "utf8"));
  writeFileSync(t.panel!.file, JSON.stringify({ ...info, token: "f".repeat(48) }));
  assert.match((await t.c.run("return 1;", SHOW(t.pr))).error!, /^Komposit's panel isn't installed in Premiere Pro yet/);
  assert.equal(t.panel!.scripts.length, 0);
  await t.done();

  // Premiere never answers (a dialog up, a long hang).
  const h = await rig({ evalScript: () => null });
  const slow = await h.c.run("return 1;", SHOW(h.pr), { timeoutMs: 300 });
  assert.equal(slow.ok, false);
  assert.equal(slow.error, "Premiere Pro didn't answer in time. If it's showing a dialog, close it. The step may still finish inside the app, so check before retrying.");
  assert.ok(h.incidents.some((i) => i.kind === "timeout"));
  // Stopped by the person.
  const ctl = new AbortController();
  const p = h.c.run("return 1;", SHOW(h.pr), { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 50);
  assert.match((await p).error!, /^Stopped before Premiere Pro answered/);
  await h.done();

  // The line drops mid-call (Premiere crashed or quit while the script ran).
  const d = await rig({ panel: false });
  const srv: Server = createServer((req) => req.socket.destroy());
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
  const file = panelAddressFile({ platform: "mac", home: d.home });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ port: (srv.address() as any).port, token: "a".repeat(48) }));
  const dropped = await d.c.run("return 1;", SHOW(d.pr));
  assert.equal(dropped.error, "Premiere Pro stopped answering in the middle of the step. It may have crashed or quit; check it, then try again.");
  assert.ok(d.incidents.some((i) => i.kind === "crash"));
  srv.close();
  await d.done();

  // An address left by a panel whose process is gone: neither the token nor a script is sent.
  const z = await rig({ panel: false });
  let hits = 0;
  const listener: Server = createServer((_req, res) => { hits++; res.end("{}"); });
  await new Promise<void>((res) => listener.listen(0, "127.0.0.1", () => res()));
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
  const zfile = panelAddressFile({ platform: "mac", home: z.home });
  mkdirSync(dirname(zfile), { recursive: true });
  writeFileSync(zfile, JSON.stringify({ port: (listener.address() as any).port, token: "b".repeat(48), pid: dead }));
  assert.match((await z.c.run("return 1;", SHOW(z.pr))).error!, /^Komposit's panel isn't installed in Premiere Pro yet/);
  assert.equal((await z.c.status()).ready, false);
  assert.equal(hits, 0, "nothing reached whatever listens on that port now");
  listener.close();
  await z.done();

  // Premiere's evalScript fails without a reason.
  const e = await rig({ evalScript: () => "EvalScript error." });
  assert.equal((await e.c.run("return 1;", SHOW(e.pr))).error, "Premiere Pro couldn't run the script (it gave no reason).");
  await e.done();
});

// ---------- installing the panel ----------

test("install: into the CEP extensions folder given, replacing an older copy of the panel whole, unsigned panels allowed through the switch given; remove; state", async () => {
  const dir = tmp("kp-pr-install-");
  const ext = join(dir, "extensions");
  // An older Komposit's panel had the same id: it is simply an older copy, replaced whole.
  const old = join(ext, PANEL_ID);
  mkdirSync(join(old, "CSXS"), { recursive: true });
  writeFileSync(join(old, "CSXS", "manifest.xml"), '<ExtensionManifest ExtensionBundleVersion="0.0.9"/>');
  writeFileSync(join(old, "old-bridge.js"), "x");
  const other = join(ext, "com.example.other");
  mkdirSync(other, { recursive: true });
  const dm = fakeDebugMode(false);
  assert.equal((await premierePanelState({ platform: "mac", extensionsDir: ext, debugMode: dm })).current, false);
  const r = await installPremierePanel({ platform: "mac", extensionsDir: ext, debugMode: dm });
  assert.deepEqual(r, { path: join(ext, PANEL_ID), version: "0.1.0", note: "Quit and reopen Premiere Pro to load it." });
  assert.deepEqual(dm.writes, [true]);
  for (const f of ["CSXS/manifest.xml", "index.html", "bridge.js"]) assert.equal(readFileSync(join(ext, PANEL_ID, f), "utf8"), readFileSync(join(PANEL_SOURCE, f), "utf8"), f);
  assert.ok(!existsSync(join(ext, PANEL_ID, "old-bridge.js")), "nothing of the older copy is left");
  assert.deepEqual(readdirSync(ext).sort(), [PANEL_ID, "com.example.other"].sort(), "other panels stay");
  // Again: a stray file in it goes.
  writeFileSync(join(ext, PANEL_ID, "stray.txt"), "x");
  await installPremierePanel({ platform: "mac", extensionsDir: ext, debugMode: dm });
  assert.ok(!existsSync(join(ext, PANEL_ID, "stray.txt")));
  const st = await premierePanelState({ platform: "mac", extensionsDir: ext, debugMode: fakeDebugMode(true) });
  assert.equal(st.current, true);
  assert.deepEqual(await removePremierePanel({ platform: "mac", extensionsDir: ext, debugMode: dm }), { removed: true });
  assert.ok(!existsSync(join(ext, PANEL_ID)) && existsSync(other));
  assert.deepEqual(dm.writes, [true, true], "PlayerDebugMode left on unless asked (other panels may need it)");
  await removePremierePanel({ platform: "mac", extensionsDir: ext, debugMode: dm, debugModeOff: true });
  assert.deepEqual(dm.writes, [true, true, false]);
  await assert.rejects(installPremierePanel({ platform: "mac", extensionsDir: ext, debugMode: dm, source: join(dir, "nowhere") }), /isn't next to this copy of Komposit/);
  assert.deepEqual(CSXS_VERSIONS, [9, 10, 11, 12, 13]);
});

// Only under the test runner: run any other way, these calls would reach the real folder.
test("install from a test without its own folder and switch is refused: the person's Premiere and PlayerDebugMode are never touched", { skip: !process.env.NODE_TEST_CONTEXT && "only under node --test" }, async () => {
  await assert.rejects(installPremierePanel({ platform: "mac" }), /A test must pass its own extensionsDir and debugMode/);
  await assert.rejects(installPremierePanel({ platform: "mac", extensionsDir: tmp("kp-pr-x-") }), /A test must pass its own/);
  await assert.rejects(removePremierePanel({ platform: "mac", debugMode: fakeDebugMode() }), /A test must pass its own/);
});

// ---------- the toolkit ----------

test("K: one line, parses without touching Premiere, has every helper the guide names; no ?: between QE calls", async () => {
  assert.ok(!K_LIB.includes("\n"), "one line, so an edit's error lines still match its own");
  assert.ok(K_LIB.trim().endsWith("})();"));
  const K = new Function(`${K_LIB} return K;`)();
  assert.deepEqual(Object.keys(K).sort(), [...K_HELPERS].sort());
  const guide = readFileSync(join(HERE, "guide.md"), "utf8");
  for (const m of guide.matchAll(/\bK\.(\w+)/g)) assert.equal(typeof K[m[1]!], "function", `the guide names K.${m[1]}`);
  for (const name of ["clip", "seq", "findItem", "effects", "addEffect", "settings", "set", "keys", "transition", "volume", "volumeKeys", "speed", "razor", "remove", "disable", "addTracks", "importFiles", "tc", "snap", "captions", "template", "qeClip", "multicam", "removeRanges", "duck", "backup"]) {
    assert.ok(guide.includes(`K.${name}`), `the guide shows K.${name}`);
  }
  assert.equal(K.levelToDb(K.dbToLevel(-6)), -6, "volume in dB round-trips (0 dB is stored as 0.1778)");
  assert.doesNotMatch(K_LIB, /\?\s*(qs|qe|P|q)\.\w+\(/);
  assert.doesNotMatch(K_LIB, /:\s*(qs|qe|P)\.get\w+\(/);
  assert.ok(!/heard|findWords/.test(K_LIB), "nothing that needs listening");
});

test("K against the stand-in: cameras cut, stretches taken out, music ducked, a backup kept, captions never over a file", async () => {
  const r = await rig();
  try {
    const seq = r.pr.show.activeSequence;
    // Stand-in QE cuts for these helpers: razor splits a clip, extract takes a stretch out.
    const split = (t: any, at: number) => {
      const i = t.clips.findIndex((c: any) => c.start.seconds < at - 1e-6 && c.end.seconds > at + 1e-6);
      if (i < 0) return;
      const c = t.clips[i], b = { ...c, nodeId: c.nodeId + "b", start: new Time(), end: c.end };
      b.start.seconds = at;
      c.end = new Time(); c.end.seconds = at;
      t.clips.splice(i + 1, 0, b);
    };
    const qe = r.pr.qe.project.getActiveSequence();
    Object.assign(r.pr.qe.project, {
      getActiveSequence: () => ({
        ...qe,
        getVideoTrackAt: (i: number) => ({ razor: (tc: string) => split(seq.videoTracks[i], Number(tc.slice(3)) / TPS) }),
        getAudioTrackAt: (i: number) => ({ razor: (tc: string) => split(seq.audioTracks[i], Number(tc.slice(3)) / TPS) }),
      }),
    });
    const cut = await r.c.run("return K.multicam([[0, 8, 1], [8, 20, 0]], { tracks: [0, 1] });", SHOW(r.pr));
    assert.deepEqual(cut, { ok: true, result: { cuts: 2, cutPoints: 2, shown: 2, hidden: 2 }, logs: [] });
    const shown = (t: any) => t.clips.filter((c: any) => !c.disabled).map((c: any) => `${c.start.seconds}-${c.end.seconds}`).join(",");
    assert.equal(shown(seq.videoTracks[0]), "8-20");
    assert.equal(shown(seq.videoTracks[1]), "0-8");
    // Captions: a free name beside the project, never over the person's file.
    const srt = join(dirname(r.pr.show.path), "Lyrics.srt");
    writeFileSync(srt, "the person's own captions");
    seq.createCaptionTrack = () => true;
    const cap = await r.c.run("return K.captions([[1, 2, 'Hello'], [3, 4, 'there']], { name: 'Lyrics' });", SHOW(r.pr));
    assert.equal(cap.ok, true, cap.error);
    assert.equal((cap.result as any).file, join(dirname(r.pr.show.path), "Lyrics 2.srt"));
    assert.equal(readFileSync(srt, "utf8"), "the person's own captions");
    assert.equal(readFileSync(join(dirname(r.pr.show.path), "Lyrics 2.srt"), "utf8"), "1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nthere\n\n");
    // A backup copy of the sequence stays in the project; the work goes on in the original.
    seq.clone = () => { r.pr.show.activeSequence = { ...seq, name: "Podcast Copy", sequenceID: "seq-copy" }; return true; };
    r.pr.show.openSequence = (id: string) => { r.pr.log.push(`openSequence:${id}`); r.pr.show.activeSequence = seq; return true; };
    assert.deepEqual(await r.c.run("return K.backup('tightening');", SHOW(r.pr)), { ok: true, result: "Podcast (before tightening)", logs: [] });
    assert.equal(r.pr.show.activeSequence, seq);
    // Older Premiere: a helper that needs a newer one says which, and which this is.
    r.pr.app.version = "13.1.5";
    delete seq.clone;
    assert.match((await r.c.run("return K.backup('x');", SHOW(r.pr))).error!, /This needs Premiere Pro 2020 or later \(this is Premiere Pro 2019, version 13\.1\.5\)\./);
  } finally {
    await r.done();
  }
});

// ---------- guide, scripts, pictures ----------

test("guide: 1.0's Premiere recipes word for word, except the ones that need listening; an index and topics", async () => {
  const m = loadConnectors("mac", { transport: createFakeTransport(), scratchDir: tmp("kp-pr-guide-") });
  const g = m.get("premiere")!.guide!;
  const index = await g();
  assert.match(index, /^Premiere Pro ExtendScript \(ES3\) — correct patterns\n/);
  assert.match(index, /- the-project: The document is the open project/);
  assert.match(await g("watch"), /Watch, don't spot-check/);
  assert.match(await g("saving"), /mode "overwrite" saves the project's own file/);
  assert.match(await g("the project"), /Name the project on every call that changes it/);
  const legacy = join(HERE, "..", "..", "legacy", "companion", "harness", "guidance.mjs");
  if (!existsSync(legacy)) return;
  const src = readFileSync(legacy, "utf8").replace(/\\`/g, "`");
  const section = /\n  premiere: `([\s\S]*?)`,\n/.exec(src)![1]!;
  const envelope = /export const ENVELOPE = `([\s\S]*?)`;/.exec(src)![1]!;
  const guide = readFileSync(join(HERE, "guide.md"), "utf8");
  const LISTENING = ["- Hear before you cut.", "- Footage that isn't on a timeline yet:", "- Words come from Premiere's own transcription"];
  const KEPT_K = (l: string) => /^  K\.(clip|effects|addEffect|set|transition|volume|speed|razor|addTracks|captions|template)\(/.test(l);
  const lines = [...section.split("\n"), ...envelope.split("\n")].filter((l) => l.startsWith("- ") || KEPT_K(l));
  assert.ok(lines.length > 20);
  for (const l of lines) {
    if (LISTENING.some((p) => l.startsWith(p))) {
      assert.ok(!guide.includes(l), `left out until v2 can listen: ${l.slice(0, 60)}`);
      continue;
    }
    assert.ok(guide.includes(l), `the guide is missing: ${l.slice(0, 80)}`);
  }
  assert.ok(!/K\.heard|listen tool|K\.findWords/.test(guide));
});

test("what goes to Premiere is ES3: no let, const, arrows, template strings or ES5 library calls", () => {
  const doc = { app: "premiere", name: "Show.prproj", path: "/p/Show.prproj" };
  const g = S.guard(doc);
  const sources = [
    K_LIB, g.before!, g.setup!, S.DOCUMENTS, S.INSPECT, S.SELECTION, S.SEQ_INFO, S.frames([null, 2], ["/a.png", "/b.png"]), S.watch([1], ["/a.png"]), S.restoreEvents("true"),
    S.encode("/o.mp4", true), S.encode("/o.mp4", false), S.SAVE_OVERWRITE, S.saveAs("/n.prproj"), S.saveCopy("/c.prproj"), S.ACTIVE_SEQUENCE_NAME, S.undo(2), S.place("/f.png"), S.open("/p.prproj"),
  ];
  for (const s of sources) {
    const { bare } = maskCode(s);
    assert.doesNotMatch(bare, /\b(let|const|class)\s|=>|`|\.(trim|forEach|map|filter|reduce|some|every|includes|startsWith|endsWith|padStart|find)\(|\bJSON\.|\bObject\.keys\b|\bArray\.isArray\b|\bDate\.now\b/, s.slice(0, 80));
  }
  assert.ok(!/\/\//.test(maskCode(g.before! + g.setup!).bare), "no // comments in the guard (it is joined onto one line)");
});

test("pictures: PNGs read (8 and 16 bits) and written, shrunk by averaging, tiled into contact sheets", () => {
  const W = 40, H = 20, px = new Uint8Array(W * H * 3);
  for (let i = 0; i < px.length; i += 3) { px[i] = 200; px[i + 1] = 100; px[i + 2] = 50; }
  const png = encodePng(px, W, H);
  const back = decodePng(png);
  assert.deepEqual([back.w, back.h, back.rgb[0], back.rgb[1], back.rgb[2]], [40, 20, 200, 100, 50]);
  const small = shrink(back, 10);
  assert.deepEqual([small.w, small.h, small.rgb[0]], [10, 5, 200]);
  assert.deepEqual(smallerPng(png, 100).bytes, png, "already small enough: as it was");
  assert.equal(smallerPng(png, 10).width, 10);
  assert.deepEqual(smallerPng(new Uint8Array([1, 2, 3]), 10).bytes, new Uint8Array([1, 2, 3]), "not a PNG this reads: as it was");
  // A 16-bit RGB PNG (what some exports write): the high byte of each sample.
  const raw = Buffer.alloc((2 * 6 + 1) * 1);
  raw.set([0, 0xab, 0xcd, 0x12, 0x34, 0x56, 0x78, 0xff, 0xff, 0x00, 0x00, 0x80, 0x00], 0);
  const be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const chunk = (type: string, data: Buffer) => Buffer.concat([be(data.length), Buffer.from(type), data, be(0)]);
  const ihdr = Buffer.concat([be(2), be(1), Buffer.from([16, 2, 0, 0, 0])]);
  const png16 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  assert.deepEqual([...decodePng(png16).rgb], [0xab, 0x12, 0x56, 0xff, 0x00, 0x80]);
  const frames = Array.from({ length: 30 }, (_, i) => ({ png: encodePng(px, W, H), label: String(i), mark: i % 7 === 0 }));
  const sheets = contactSheets(frames);
  assert.equal(sheets.count, 30);
  assert.equal(sheets.sheets.length, 1);
  const sheet = decodePng(sheets.sheets[0]!);
  assert.ok(sheet.w > W && sheet.h > H);
  assert.throws(() => contactSheets([{ png: new Uint8Array([0]), label: "0" }]), /couldn't be read to make a contact sheet/);
  assert.equal(summarizeSelection({ noDocument: true }), "No project open in Premiere Pro.");
  assert.equal(summarizeSelection({ project: "Show.prproj" }), 'Project "Show.prproj", no sequence open.');
});

test("the stand-in's own sense check: its time stamps and frame colors are what the tests above assume", () => {
  const t = new Time();
  t.seconds = 2;
  assert.equal(t.ticks, String(2 * TPS));
  assert.equal(basename(PANEL_SOURCE.replace(/\/$/, "")), "panel");
});

test("Show in: Premiere Pro's own app bundle, from the running program", async () => {
  const { appBundleOf } = await import("./index.ts");
  assert.equal(appBundleOf("/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/MacOS/Adobe Premiere Pro 2026\n"), "/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app");
  assert.equal(appBundleOf("Adobe Premiere Pro"), null);
  assert.equal(appBundleOf(""), null);
});

// ---------- the request's sequence ----------

test("the request's sequence by id: edits, info and video stay on it when the person opens another; frames refuse plainly instead of switching the timeline", async () => {
  const r = await rig();
  try {
    const podcast = r.pr.show.activeSequence;
    // A second sequence in the project, and the person opens it mid-request.
    const broll = { ...podcast, name: "B-roll", sequenceID: "seq-b" };
    r.pr.show.sequences.push(broll);
    const inPodcast: DocRef = { ...SHOW(r.pr), part: { id: "seq-doc-1", name: "Podcast" } };
    r.pr.show.activeSequence = broll;

    const e = await r.c.run("return [K.seq().name, K.seq().sequenceID];", inPodcast);
    assert.deepEqual(e.result, ["Podcast", "seq-doc-1"], "the request's sequence, not the one open now");
    assert.equal(JSON.parse((await r.c.inspect(inPodcast)).text).sequence.name, "Podcast");
    // Frames (QE) only come from the open sequence: a plain refusal, the timeline left alone.
    const before = r.pr.log.length;
    await assert.rejects(r.c.render(inPodcast), /^Error: The sequence this request works in, Podcast, is not the one open in the timeline \(B-roll is\), and Premiere Pro draws frames and makes cuts only in the open one, so nothing ran\./);
    assert.ok(!r.pr.log.slice(before).some((l) => l.startsWith("openSequence") || l.startsWith("exportFramePNG")), r.pr.log.slice(before).join(" "));
    const cut = await r.c.run("K.razor(2); return 1;", inPodcast);
    assert.equal(cut.ok, false);
    assert.match(cut.error ?? "", /^The sequence this request works in, Podcast, is not the one open in the timeline/);
    // Back in the open sequence: frames as before.
    r.pr.show.activeSequence = podcast;
    assert.ok((await r.c.render(inPodcast)).picture);
    // By name; and a sequence that's gone is said plainly.
    assert.equal((await r.c.run("return K.seq().name;", { ...SHOW(r.pr), part: { name: "B-roll" } })).result, "B-roll");
    const gone = await r.c.run("return 1;", { ...SHOW(r.pr), part: { id: "seq-x", name: "Old cut" } });
    assert.equal(gone.ok, false);
    assert.equal(gone.error, "The sequence Old cut is not in Show.prproj anymore, so nothing ran.");
  } finally {
    await r.done();
  }
});
