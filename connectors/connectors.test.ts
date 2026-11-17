// The three scripting connectors, driven through a FAKE transport only: the scripts
// Komposit would send run in a Node vm against a small stand-in DOM, so quiet mode,
// document targeting, the After Effects result-file handoff, exports and error wording are
// tested end to end without a real app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Connector } from "../protocol/connector.ts";
import { createKit } from "./_kit/adobe.ts";
import type { ConnectorOptions } from "./_kit/adobe.ts";
import { createDialogWatcher } from "./_kit/dialogwatch.ts";
import { createFakeTransport, fakeFileClass, tinyPng } from "./_kit/fake.ts";
import type { FakeTransportOptions } from "./_kit/fake.ts";
import type { Incident } from "./_kit/incidents.ts";
import { osascriptFailure } from "./_kit/mac.ts";
import { createAfterEffects } from "./aftereffects/index.ts";
import { summarizeSelection as aeSummary } from "./aftereffects/summary.ts";
import { createIllustrator } from "./illustrator/index.ts";
import { summarizeSelection as aiSummary } from "./illustrator/summary.ts";
import { loadConnectors } from "./index.ts";
import { createPhotoshop } from "./photoshop/index.ts";
import { summarizeSelection as psSummary } from "./photoshop/summary.ts";

// Temp folders this file makes are removed when the test process ends.
const madeDirs: string[] = [];
process.once("exit", () => { for (const d of madeDirs) rmSync(d, { recursive: true, force: true }); });
const keep = (d: string) => (madeDirs.push(d), d);

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- stand-in apps ----------

// Where Illustrator's picture exports and Photoshop's Save for Web really put a file: spaces
// in the name become hyphens, and a file with that name is overwritten (live test, Nov 15).
const appMangled = (p: string) => join(dirname(p), basename(p).replace(/ /g, "-"));

/** ExtendScript's Folder over the real disk (tests write into temp folders). */
function fakeFolderClass(File: ReturnType<typeof fakeFileClass>) {
  return class Folder {
    fsName: string;
    name: string;
    constructor(path: string) {
      this.fsName = String(path);
      this.name = encodeURI(basename(this.fsName));
    }
    get exists() {
      return existsSync(this.fsName);
    }
    create() {
      mkdirSync(this.fsName, { recursive: true });
      return true;
    }
    remove() {
      // Like ExtendScript: an empty folder only.
      try { rmdirSync(this.fsName); return true; } catch { return false; }
    }
    getFiles(): unknown[] {
      return readdirSync(this.fsName).map((n) => {
        const p = join(this.fsName, n);
        return statSync(p).isDirectory() ? new Folder(p) : new File(p);
      });
    }
  };
}

function illustratorDom(log: string[]) {
  const virtual = new Set(["/v/a.ai", "/v/b.ai", "/w/a.ai"]);
  const File = fakeFileClass(virtual);
  const Folder = fakeFolderClass(File);
  const artboards = () => Object.assign([{ name: "Front", artboardRect: [0, 200, 100, 0] }], { getActiveArtboardIndex: () => 0 });
  const mkDoc = (name: string, path: string) => ({
    name,
    fullName: { fsName: path },
    artboards: artboards(),
    layers: [],
    textFrames: [],
    selection: [],
    documentColorSpace: "RGB",
    saved: true,
    /** Steps exportFile left in the undo history. */
    hiddenSteps: 0,
    // Like the real Illustrator (30.5 and 2026, seen in the live tests): an export marks the
    // document as changed and leaves a hidden step in its undo history.
    exportFile(this: { saved: boolean; hiddenSteps: number }, file: { fsName: string }, type: string) {
      writeFileSync(appMangled(file.fsName), tinyPng(100, 200));
      log.push(`export:${name}:${type}`);
      this.saved = false;
      this.hiddenSteps++;
    },
    // Export for Screens: <folder>/<factor>x/<prefix><artboard>.<ext>, the history and the
    // saved flag left alone (live test, Nov 16).
    exportForScreens(this: { artboards: { name: string }[] }, folder: { fsName: string }, type: string, opts: { scaleTypeValue?: number }, item: { artboards: string }, prefix: string) {
      const ab = this.artboards[Number(item.artboards) - 1]!;
      const dir = join(folder.fsName, `${opts.scaleTypeValue ?? 1}x`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${prefix}${ab.name}.${type === "jpg80" ? "jpg" : "png"}`), tinyPng(100, 200));
      log.push(`screens:${name}:${type}:${opts.scaleTypeValue}`);
    },
  });
  const docs = [mkDoc("a.ai", "/v/a.ai"), mkDoc("b.ai", "/v/b.ai"), mkDoc("a.ai", "/w/a.ai"), mkDoc("Untitled-1", "/Untitled-1")];
  let active = docs[0];
  const app = {
    version: "29.0",
    userInteractionLevel: "DISPLAY",
    documents: docs,
    get activeDocument() {
      if (!docs.length) throw new Error("There is no document.");
      return active;
    },
    set activeDocument(d) {
      active = d;
      log.push(`activate:${d.name}${d.fullName.fsName === "/w/a.ai" ? "(w)" : ""}`);
    },
    undo() {
      log.push("undo");
    },
  };
  return {
    app,
    docs,
    globals: () => ({
      app,
      File,
      Folder,
      ExportForScreensType: { SE_PNG24: "png24", SE_JPEG80: "jpg80" },
      ExportForScreensScaleType: { SCALEBYFACTOR: "factor" },
      ExportForScreensOptionsPNG24: class {},
      ExportForScreensOptionsJPEG: class {},
      ExportForScreensItemToExport: class {},
      AntiAliasingMethod: { ARTOPTIMIZED: "art" },
      UserInteractionLevel: { DONTDISPLAYALERTS: "DONT", DISPLAYALERTS: "DISPLAY" },
      ExportOptionsPNG24: class {},
      ExportOptionsJPEG: class {},
      ExportOptionsSVG: class {},
      ExportType: { PNG24: "png24", JPEG: "jpeg", SVG: "svg" },
      DocumentColorSpace: { RGB: "RGB", CMYK: "CMYK" },
    }),
  };
}

function photoshopDom(log: string[]) {
  const File = fakeFileClass(new Set(["/v/p.psd"]));
  interface Doc {
    name: string;
    id: number;
    saved: boolean;
    readonly fullName: { fsName: string };
    historyStates: { name: string }[];
    activeHistoryState: unknown;
    suspendHistory(name: string, js: string): void;
    exportDocument(file: { fsName: string }): void;
    duplicate(newName: string, merged: boolean): Doc;
    close(how: string): void;
  }
  let nextId = 100;
  const mkDoc = (name: string, id: number, path: string | null): Doc => ({
    name,
    id,
    saved: true,
    get fullName() {
      if (!path) throw new Error("The document has not yet been saved.");
      return { fsName: path };
    },
    historyStates: [{ name: "Open" }, { name: "Brush" }, { name: "Fill" }],
    activeHistoryState: null as unknown,
    // Like Photoshop: the string runs (here with ExtendScript's $), and everything it does is
    // one history state with the name given.
    suspendHistory(this: Doc, name: string, js: string) {
      log.push(`suspend:${name}`);
      new Function("$", js)(dollar);
      this.historyStates.push({ name });
      this.activeHistoryState = this.historyStates[this.historyStates.length - 1];
    },
    // Like the real Photoshop 2026 (live test): Save for Web marks the document as changed
    // and hyphenates the file name.
    exportDocument(this: Doc, file: { fsName: string }) {
      writeFileSync(appMangled(file.fsName), tinyPng(800, 600));
      log.push(`export:${this.name}`);
      this.saved = false;
    },
    duplicate(this: Doc, newName: string, merged: boolean) {
      const d = mkDoc(newName, nextId++, null);
      docs.push(d);
      active = d;
      log.push(`duplicate:${this.name}${merged ? ":merged" : ""}`);
      return d;
    },
    close(this: Doc, how: string) {
      docs.splice(docs.indexOf(this), 1);
      if (active === this) active = docs[0];
      log.push(`close:${this.name}:${how}`);
    },
  });
  const dollar = { global: {} as Record<string, unknown> };
  const docs: Doc[] = [mkDoc("p.psd", 11, "/v/p.psd"), mkDoc("Untitled-1", 12, null)];
  let active = docs[0]!;
  const app = {
    version: "27.0",
    displayDialogs: "ALL",
    documents: docs,
    get activeDocument() {
      return active;
    },
    set activeDocument(d) {
      active = d;
      log.push(`activate:${d.name}`);
    },
  };
  return { app, docs, globals: () => ({ app, File, $: dollar, DialogModes: { NO: "NO", ALL: "ALL" }, SaveOptions: { DONOTSAVECHANGES: "dont-save" }, ExportOptionsSaveForWeb: class {}, SaveDocumentType: { PNG: "png", JPEG: "jpg" }, ExportType: { SAVEFORWEB: "sfw" } }) };
}

function afterEffectsDom(log: string[]) {
  const File = fakeFileClass(new Set(["/v/My Project.aep"]));
  let nextId = 1;
  const list: CompItem[] = [];
  class CompItem {
    id = nextId++;
    name = "Main";
    time = 1;
    workAreaStart = 0;
    workAreaDuration = 2;
    frameDuration = 0.5;
    duration = 10;
    width = 1920;
    height = 1080;
    frameRate = 30;
    numLayers = 0;
    /** The comps this one is a layer in (a precomp's). */
    usedIn: CompItem[] = [];
    saveFrameToPng(t: number, f: { fsName: string }) {
      writeFileSync(f.fsName, tinyPng(1920, 1080));
      log.push(`frame:${t}`);
    }
    openInViewer() {
      project.activeItem = this;
      log.push("viewer");
    }
  }
  const comp = new CompItem();
  list.push(comp);
  const items = {
    addComp(name: string, w: number, h: number, _pa: number, duration: number, fps: number) {
      log.push(`addComp:${name}:${w}x${h}:${duration}s:${fps}`);
      const c = Object.assign(new CompItem(), { name, width: w, height: h, duration, frameRate: fps });
      list.push(c);
      return c;
    },
  };
  // The render queue, enough for an H.264 preview: the output module's file is written on render().
  let rqOut: { fsName: string } | null = null;
  const renderQueue = {
    numItems: 0,
    item: () => null,
    items: {
      add: () => ({
        timeSpanStart: 0,
        timeSpanDuration: 0,
        setSettings() {},
        remove() {},
        outputModule: () => ({ templates: ["H.264 - Match Render Settings - 15 Mbps"], applyTemplate() {}, set file(f: { fsName: string }) { rqOut = f; } }),
      }),
    },
    render() {
      if (rqOut) writeFileSync(rqOut.fsName, "fake mp4");
      log.push("rq-render");
    },
  };
  const project = {
    file: new File("/v/My Project.aep"),
    get numItems() { return list.length; },
    item: (i: number) => list[i - 1],
    activeItem: comp as CompItem | null,
    items,
    renderQueue,
    save: () => log.push("save"),
  };
  const app = {
    version: "26.5",
    project,
    mark: (s: string) => log.push(s),
    beginSuppressDialogs: () => log.push("begin"),
    beginUndoGroup: (n: string) => log.push(`undo-group:${n}`),
    endUndoGroup: () => log.push("undo-group-end"),
    endSuppressDialogs: (alert: boolean) => log.push(`end:${alert}`),
    // Like After Effects 2026 (live test, Nov 16): "Undo" finds some other menu's item (2371),
    // which does nothing here; Edit > Undo is command 16.
    findMenuCommandId: (name: string) => (name === "Undo" ? 2371 : 0),
    executeCommand: (id: number) => log.push(id === 16 ? "undo" : `command:${id}`),
  };
  return { app, globals: () => ({ app, File, CompItem, RQItemStatus: { QUEUED: 1 }, $: { sleep() {} } }) };
}

interface Rig {
  dir: string;
  home: string;
  log: string[];
  incidents: Incident[];
  transport: ReturnType<typeof createFakeTransport>;
  dom: { app: any };
  c: Connector;
  done(): void;
}

function rig(make: "illustrator" | "photoshop" | "aftereffects", fake: FakeTransportOptions = {}, opts: ConnectorOptions = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "kp-conn-"));
  const home = join(dir, "home");
  mkdirSync(home);
  const log: string[] = [];
  const incidents: Incident[] = [];
  const dom = make === "illustrator" ? illustratorDom(log) : make === "photoshop" ? photoshopDom(log) : afterEffectsDom(log);
  const transport = createFakeTransport({ globals: dom.globals, ...fake });
  const kit = createKit(fake.platform || "mac", { transport, scratchDir: join(dir, "scratch"), home, onIncident: (i) => incidents.push(i), ...opts });
  const c = make === "illustrator" ? createIllustrator(kit) : make === "photoshop" ? createPhotoshop(kit) : createAfterEffects(kit);
  return { dir, home, log, incidents, transport, dom, c, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------- tests ----------

test("loadConnectors: the three scripting apps, one door, ExtendScript (Premiere Pro, through its panel, in premiere/)", () => {
  const m = loadConnectors("mac", { transport: createFakeTransport(), scratchDir: keep(mkdtempSync(join(tmpdir(), "kp-load-"))) });
  assert.deepEqual([...m.keys()], ["illustrator", "photoshop", "aftereffects", "premiere"]);
  assert.equal(m.get("premiere")!.manifest.door, "in-app-plugin");
  m.delete("premiere");
  for (const c of m.values()) {
    assert.equal(c.manifest.door, "os-script");
    assert.equal(c.manifest.language, "extendscript");
    assert.deepEqual(c.manifest.platforms, ["mac", "win"]);
    assert.deepEqual(c.manifest.heavy, ["render", "export", "inspect"], "inspect draws a picture too");
  }
  assert.deepEqual(m.get("illustrator")!.manifest.capabilities.export, ["png", "jpg", "svg", "pdf"]);
  assert.deepEqual(m.get("photoshop")!.manifest.capabilities.save, ["copy", "overwrite", "as"]);
  assert.deepEqual(m.get("aftereffects")!.manifest.capabilities.save, ["overwrite"]);
  assert.equal(m.get("aftereffects")!.manifest.capabilities.singleDocument, true);
  assert.equal(m.get("illustrator")!.manifest.capabilities.preflight, true);
  assert.equal(loadConnectors("win", { transport: createFakeTransport({ platform: "win" }) }).size, 4);
});

test("Illustrator: every script runs in quiet mode, restored afterwards, even when it fails", async () => {
  const r = rig("illustrator");
  try {
    const ok = await r.c.run("return app.userInteractionLevel;");
    assert.deepEqual(ok, { ok: true, result: "DONT", logs: [] });
    const bad = await r.c.run("throw new Error('Target layer cannot be modified');");
    assert.equal(bad.ok, false);
    // The app's words first, then a hint the AI can act on; the incident keeps the app's words.
    assert.match(String(bad.error), /^Target layer cannot be modified\. Hint: The layer being drawn into.*locked or hidden/);
    assert.ok(r.transport.calls.at(-1)!.source.includes("DONTDISPLAYALERTS"), "the guard is in the script sent");
    // Back to what the person had.
    assert.equal(r.dom.app.userInteractionLevel, "DISPLAY");
    // A script error goes to the incident log, with the script.
    assert.equal(r.incidents.length, 1);
    assert.equal(r.incidents[0].kind, "script-error");
    assert.match(r.incidents[0].script || "", /Target layer/);
    assert.equal(r.incidents[0].message, "Target layer cannot be modified");
  } finally {
    r.done();
  }
});

test("Illustrator: a DocRef targets that document, then the person's front document comes back", async () => {
  const log: string[] = [];
  const dom = illustratorDom(log);
  const dir = mkdtempSync(join(tmpdir(), "kp-ai-"));
  try {
    const kit = createKit("mac", { transport: createFakeTransport({ globals: dom.globals }), scratchDir: dir, home: dir });
    const c = createIllustrator(kit);
    const r1 = await c.run("return doc.name + '|' + app.activeDocument.name + '|' + app.userInteractionLevel;", { app: "illustrator", name: "b.ai", path: "/v/b.ai" });
    assert.equal(r1.result, "b.ai|b.ai|DONT");
    assert.equal(dom.app.activeDocument.name, "a.ai", "the person's front document is back");
    assert.equal(dom.app.userInteractionLevel, "DISPLAY", "quiet mode is off again");
    assert.deepEqual(log, ["activate:b.ai", "activate:a.ai"]);

    // Same name, other folder: the path decides.
    log.length = 0;
    const r2 = await c.run("return doc.fullName.fsName;", { app: "illustrator", name: "a.ai", path: "/w/a.ai" });
    assert.equal(r2.result, "/w/a.ai");
    assert.deepEqual(log, ["activate:a.ai(w)", "activate:a.ai"]);

    // The front document: nothing is switched.
    log.length = 0;
    assert.equal((await c.run("return doc.name;", { app: "illustrator", name: "a.ai", path: "/v/a.ai" })).result, "a.ai");
    assert.deepEqual(log, []);

    // Never saved: found by name. Closed: a plain sentence.
    assert.equal((await c.run("return doc.name;", { app: "illustrator", name: "Untitled-1" })).result, "Untitled-1");
    const gone = await c.run("return 1;", { app: "illustrator", name: "c.ai", path: "/v/c.ai" });
    assert.equal(gone.ok, false);
    assert.match(String(gone.error), /^c\.ai is not open in Illustrator anymore\. Hint: /);
    assert.equal(dom.app.userInteractionLevel, "DISPLAY");

    // No DocRef: the front document, as `doc`.
    assert.equal((await c.run("return doc.name;")).result, "a.ai");

    const docs = await c.documents();
    assert.deepEqual(docs.map((d) => [d.name, d.path ?? null, d.active]), [
      ["a.ai", "/v/a.ai", true],
      ["b.ai", "/v/b.ai", false],
      ["a.ai", "/w/a.ai", false],
      ["Untitled-1", null, false],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Illustrator: render returns a picture with its size; the scratch file is removed", async () => {
  const r = rig("illustrator");
  try {
    const out = await r.c.render({ app: "illustrator", name: "b.ai", path: "/v/b.ai" });
    assert.equal(out.picture?.mime, "image/png");
    assert.deepEqual([out.picture?.width, out.picture?.height], [100, 200]);
    assert.equal(out.note, 'the active artboard "Front"');
    assert.deepEqual(readdirSync(join(r.dir, "scratch")).filter((f) => f.endsWith(".png")), []);
    assert.match(r.transport.calls[0].source, /Math\.round\(1024\*100/, "the render size limit");
  } finally {
    r.done();
  }
});

test("Illustrator: a render or a picture export leaves a saved document saved, and an unsaved one unsaved", async () => {
  const r = rig("illustrator");
  try {
    const dom = r.dom as ReturnType<typeof illustratorDom>;
    const b = dom.docs[1]!;
    await r.c.render({ app: "illustrator", name: "b.ai", path: "/v/b.ai" });
    assert.equal(b.saved, true, "render");
    await r.c.inspect({ app: "illustrator", name: "b.ai", path: "/v/b.ai" });
    assert.equal(b.saved, true, "inspect (it renders too)");
    const png = await r.c.exportCopy({ doc: { app: "illustrator", name: "b.ai", path: "/v/b.ai" }, format: "png", outputDir: join(r.dir, "home", "out") });
    assert.equal(png.ok, true, png.error);
    assert.equal(b.saved, true, "png export");
    // A document with unsaved changes keeps them: nothing is marked saved that wasn't.
    b.saved = false;
    await r.c.render({ app: "illustrator", name: "b.ai", path: "/v/b.ai" });
    assert.equal(b.saved, false);
  } finally {
    r.done();
  }
});

test("Illustrator: pictures and PNG and JPG exports leave the undo history alone (Export for Screens, not exportFile)", async () => {
  // Seen live (Illustrator 2026, Nov 16): every exportFile left a hidden step in the document's
  // undo history, so after Komposit looked at the document the next undo (the AI's, or the
  // person's Cmd+Z) undid nothing visible. Export for Screens leaves the history alone.
  const r = rig("illustrator");
  try {
    const dom = r.dom as ReturnType<typeof illustratorDom>;
    const b = dom.docs[1]!;
    const ref = { app: "illustrator", name: "b.ai", path: "/v/b.ai" };
    const shot = await r.c.render(ref);
    assert.deepEqual([shot.picture?.width, shot.picture?.height], [100, 200]);
    await r.c.inspect(ref);
    const png = await r.c.exportCopy({ doc: ref, format: "png", name: "logo" });
    const jpg = await r.c.exportCopy({ doc: ref, format: "jpg", name: "logo" });
    assert.ok(png.ok && jpg.ok, png.error ?? jpg.error);
    assert.deepEqual([basename(png.path!), basename(jpg.path!)], ["logo.png", "logo.jpg"]);
    assert.equal(b.hiddenSteps, 0, "no hidden step in the history");
    assert.deepEqual(r.log.filter((l) => l.startsWith("screens:")).map((l) => l.split(":").slice(2).join(":")), ["png24:1", "png24:1", "png24:1", "jpg80:1"]);
    assert.deepEqual(readdirSync(join(r.dir, "scratch")).filter((f) => f.endsWith(".d")), [], "the Export for Screens folders are removed");
    // SVG is the whole document: exportFile still (it leaves the hidden step).
    const svg = await r.c.exportCopy({ doc: ref, format: "svg", name: "logo" });
    assert.equal(svg.ok, true, svg.error);
    assert.equal(b.hiddenSteps, 1);
  } finally {
    r.done();
  }
});

test("picture exports keep the name Komposit picked and never replace a file, though the apps hyphenate names", async () => {
  for (const make of ["illustrator", "photoshop"] as const) {
    const r = rig(make);
    try {
      const out = join(r.home, "out");
      mkdirSync(out);
      // The person's own file, with the name the app would turn "my logo" into.
      writeFileSync(join(out, "my-logo.png"), "the person's own file");
      const a = await r.c.exportCopy({ format: "png", name: "my logo", outputDir: out });
      assert.equal(a.ok, true, a.error);
      assert.equal(a.path, join(out, "my logo.png"), make);
      assert.ok(existsSync(a.path!), `${make}: the file is where the result says`);
      assert.equal(readFileSync(join(out, "my-logo.png"), "utf8"), "the person's own file", `${make}: not overwritten`);
      const b = await r.c.exportCopy({ format: "png", name: "my logo", outputDir: out });
      assert.equal(b.path, join(out, "my logo 2.png"));
      assert.ok(existsSync(b.path!));
      assert.deepEqual(readdirSync(out).sort(), ["my logo 2.png", "my logo.png", "my-logo.png"], make);
      assert.deepEqual(readdirSync(join(r.dir, "scratch")).filter((f) => f.endsWith(".png")), [], `${make}: nothing left in scratch`);
    } finally {
      r.done();
    }
  }
});

test("Photoshop: a render leaves a saved document saved (made from a duplicate, closed after); one with changes is rendered directly", async () => {
  const r = rig("photoshop");
  try {
    const dom = r.dom as ReturnType<typeof photoshopDom>;
    const p = dom.docs[0]!;
    const pic = await r.c.render({ app: "photoshop", name: "p.psd", path: "/v/p.psd", id: "11" });
    assert.ok(pic.picture);
    assert.equal(p.saved, true);
    assert.deepEqual(r.log.filter((l) => /^(duplicate|export|close)/.test(l)), ["duplicate:p.psd:merged", "export:Komposit preview", "close:Komposit preview:dont-save"]);
    assert.equal(dom.docs.length, 2, "the duplicate is gone");
    assert.equal(dom.app.activeDocument, p, "the document is in front again");
    r.log.length = 0;
    p.saved = false;
    await r.c.render({ app: "photoshop", name: "p.psd", path: "/v/p.psd", id: "11" });
    assert.deepEqual(r.log.filter((l) => /^(duplicate|export|close)/.test(l)), ["export:p.psd"]);
  } finally {
    r.done();
  }
});

test("exports: a new file every time, never over an existing one; outside home is refused plainly", async () => {
  const r = rig("illustrator");
  try {
    const exports = join(r.home, "Komposit Exports");
    mkdirSync(exports);
    writeFileSync(join(exports, "poster.png"), "the person's own file");
    const a = await r.c.exportCopy({ format: "png", name: "poster" });
    assert.equal(a.ok, true);
    assert.equal(a.path, join(exports, "poster 2.png"));
    assert.equal(a.sourceUnchanged, true);
    assert.match(a.note || "", /^PNG of the active artboard/);
    const b = await r.c.exportCopy({ format: "PNG", name: "poster.png" });
    assert.equal(b.path, join(exports, "poster 3.png"));
    assert.equal(readFileSync(join(exports, "poster.png"), "utf8"), "the person's own file");
    // No name: the document's, without its extension.
    assert.equal((await r.c.exportCopy({ format: "jpg" })).path, join(exports, "a.jpg"));
    assert.equal((await r.c.exportCopy({ format: "svg", doc: { app: "illustrator", name: "b.ai", path: "/v/b.ai" } })).path, join(exports, "b.svg"));

    const calls = r.transport.calls.length;
    const tiff = await r.c.exportCopy({ format: "tiff" });
    assert.deepEqual(tiff, { ok: false, error: 'Illustrator can export png, jpg, svg, pdf; not "tiff".' });
    const outside = await r.c.exportCopy({ format: "png", outputDir: "/etc" });
    assert.equal(outside.ok, false);
    assert.match(outside.error || "", /^Komposit only writes inside your home folder or a project's folder/);
    assert.equal(r.transport.calls.length, calls, "refused before touching the app");
  } finally {
    r.done();
  }
});

test("Photoshop: quiet mode (displayDialogs NO), DocRef by Photoshop's document id, undo steps", async () => {
  const log: string[] = [];
  const dom = photoshopDom(log);
  const dir = mkdtempSync(join(tmpdir(), "kp-ps-"));
  try {
    const transport = createFakeTransport({ globals: dom.globals });
    const c = createPhotoshop(createKit("mac", { transport, scratchDir: join(dir, "s"), home: dir }));
    const r = await c.run("return [doc.name, app.displayDialogs].join('|');", { app: "photoshop", name: "renamed?", id: "12" });
    assert.equal(r.result, "Untitled-1|NO");
    assert.equal(dom.app.displayDialogs, "ALL", "restored");
    assert.equal(dom.app.activeDocument.name, "p.psd", "the person's front document is back");
    const docs = await c.documents();
    assert.deepEqual(docs, [
      { app: "photoshop", name: "p.psd", path: "/v/p.psd", id: "11", active: true },
      { app: "photoshop", name: "Untitled-1", id: "12", active: false },
    ]);
    // An id that's gone isn't matched by name (another "Untitled-1" would be someone else's).
    const gone = await c.run("return 1;", { app: "photoshop", name: "Untitled-1", id: "99" });
    assert.match(String(gone.error), /^Untitled-1 is not open in Photoshop anymore\. Hint: That document was closed/);
    // Undo takes back only Komposit's own history states.
    const p = { app: "photoshop", name: "p.psd", id: "11" };
    const mine = await c.undo(p, 1);
    assert.deepEqual(mine, { ok: false, error: "The latest step in p.psd's history is Fill, not one of Komposit's, so nothing was undone: Komposit only takes back its own changes.", logs: [] });
    assert.equal(dom.docs[0].activeHistoryState, null, "nothing changed");
    const pic = await c.render();
    assert.deepEqual([pic.picture?.width, pic.picture?.height], [800, 600]);
    assert.equal((await c.exportCopy({ format: "pdf" })).error, 'Photoshop can export png and jpg; not "pdf".');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one named undo step per edit: Photoshop's history state, After Effects' undo group; Illustrator refuses app.redraw()", async () => {
  // Photoshop: the edit runs inside suspendHistory, one state with Komposit's name; undo steps
  // back over Komposit's states only.
  const ps = rig("photoshop");
  try {
    const p = { app: "photoshop", name: "p.psd", id: "11" };
    const r = await ps.c.run("app.mark = 1; return doc.name;", p, { label: "Komposit: Recolour the title" });
    assert.deepEqual([r.ok, r.result], [true, "p.psd"]);
    assert.ok(ps.log.includes("suspend:Komposit: Recolour the title"), ps.log.join(" "));
    const docs = (ps.dom as any).docs;
    const hist = () => docs[0].historyStates.map((h: { name: string }) => h.name);
    assert.deepEqual(hist(), ["Open", "Brush", "Fill", "Komposit: Recolour the title"]);
    // An error inside comes back as the edit's error (and is still one state).
    const bad = await ps.c.run("throw new Error('Layer locked');", p, { label: "Komposit: Move the logo" });
    assert.deepEqual([bad.ok, bad.error], [false, "Layer locked"]);
    assert.equal(hist().at(-1), "Komposit: Move the logo");
    // Reads and edits without a label stay out of the history.
    await ps.c.run("return 1;", p);
    assert.equal(hist().length, 5);
    // Undo: back over Komposit's two states, then it stops at the person's.
    assert.deepEqual(await ps.c.undo(p, 1), { ok: true, result: 1, logs: [] });
    assert.equal(docs[0].activeHistoryState.name, "Komposit: Recolour the title");
    assert.equal((await ps.c.undo(p, 1)).ok, true);
    assert.equal(docs[0].activeHistoryState.name, "Fill");
    const stop = await ps.c.undo(p, 1);
    assert.equal(stop.ok, false);
    assert.match(stop.error ?? "", /^The latest step in p\.psd's history is Fill, not one of Komposit's/);
    assert.equal(docs[0].activeHistoryState.name, "Fill");
  } finally {
    ps.done();
  }

  // After Effects: one undo group around the edit, closed even when it fails.
  const ae = rig("aftereffects");
  try {
    await ae.c.run("app.mark('code'); return 1;", undefined, { label: "Komposit: Ease the title in" });
    assert.deepEqual(ae.log, ["begin", "undo-group:Komposit: Ease the title in", "code", "undo-group-end", "end:false"]);
    ae.log.length = 0;
    await ae.c.run("throw new Error('no');", undefined, { label: "Komposit: x" });
    assert.deepEqual(ae.log, ["begin", "undo-group:Komposit: x", "undo-group-end", "end:false"]);
    ae.log.length = 0;
    await ae.c.run("return 1;");
    assert.deepEqual(ae.log, ["begin", "end:false"], "no group for a call without a label (reads)");
  } finally {
    ae.done();
  }

  // Illustrator: no undo grouping; app.redraw() would split the edit, so it's refused.
  const il = rig("illustrator");
  try {
    const r = await il.c.run("var x = 1;\napp.redraw();\nreturn x;");
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /^app\.redraw\(\) isn't allowed in a Komposit edit: in Illustrator each call ends an undo step/);
    assert.equal(il.transport.calls.length, 0, "nothing was sent");
    assert.equal((await il.c.run("var redraws = 1; return redraws;")).ok, true);
  } finally {
    il.done();
  }
});

test("Windows: the same scripts, compiled with eval inside the envelope", async () => {
  const r = rig("photoshop", { platform: "win" });
  try {
    const res = await r.c.run("return 1 +;");
    assert.equal(res.ok, false, "a syntax error comes back as an error, not a crash");
    assert.ok(res.error);
    assert.match(r.transport.calls[0].source, /__result\.data = eval\(/);
  } finally {
    r.done();
  }
});

test("After Effects: a new comp has the size and length asked for, opens in the viewer, and comes back with its project", async () => {
  const r = rig("aftereffects");
  try {
    const d = await r.c.newDocument!({ width: 1080, height: 1350, seconds: 6 });
    assert.deepEqual(d, { app: "aftereffects", name: "My Project.aep", path: "/v/My Project.aep", comp: "Komposit Comp" });
    assert.ok(r.log.includes("addComp:Komposit Comp:1080x1350:6s:30"), r.log.join(" "));
    assert.ok(r.log.includes("viewer"));
    // No length asked: 10 seconds. A silly one is kept within an hour.
    await r.c.newDocument!({});
    assert.ok(r.log.includes("addComp:Komposit Comp:1920x1080:10s:30"));
    await r.c.newDocument!({ seconds: 99999 });
    assert.ok(r.log.includes("addComp:Komposit Comp:1920x1080:3600s:30"));
  } finally {
    r.done();
  }
});

test("After Effects: dialogs suppressed around every script; the result comes back through a file", async () => {
  const r = rig("aftereffects");
  try {
    const res = await r.c.run("app.mark('code'); return { project: app.project.file.fsName };");
    assert.deepEqual(res, { ok: true, result: { project: "/v/My Project.aep" }, logs: [] });
    assert.deepEqual(r.log, ["begin", "code", "end:false"]);
    assert.equal(r.transport.calls[0].opts.via, "file");
    assert.equal(r.transport.calls[0].opts.timeoutMs, 180000);
    // Even when the script throws.
    r.log.length = 0;
    const bad = await r.c.run("app.mark('code'); throw new Error('Layer 3 has no Position');");
    assert.deepEqual([bad.ok, bad.error], [false, "Layer 3 has no Position"]);
    assert.deepEqual(r.log, ["begin", "code", "end:false"]);
    // A DocRef must be the project that's open.
    r.log.length = 0;
    const other = await r.c.run("app.mark('code'); return 1;", { app: "aftereffects", name: "Other.aep", path: "/v/Other.aep" });
    assert.deepEqual([other.ok, other.error], [false, "Other.aep isn't open in After Effects anymore: the project open there is My Project.aep. Hint: The project was closed or another one opened, or the comp was deleted or renamed. Calls with no doc stay on the request's comp, so don't carry on somewhere else on your own: tell the user, and if they want you to work in another comp, name it as doc part."]);
    assert.deepEqual(r.log, ["begin", "end:false"], "nothing ran, dialogs back on");
    assert.equal((await r.c.run("return 2;", { app: "aftereffects", name: "My Project.aep", path: "/v/My Project.aep" })).result, 2);
    assert.deepEqual(await r.c.documents(), [{ app: "aftereffects", name: "My Project.aep", path: "/v/My Project.aep", active: true, comps: ["Main"], part: { id: "1", name: "Main" } }]);
    // No result files left behind.
    assert.deepEqual(readdirSync(join(r.dir, "scratch")).filter((f) => f.startsWith("result-")), []);
  } finally {
    r.done();
  }
});

test("After Effects: render frames across the work area, the middle one as the picture", async () => {
  const r = rig("aftereffects");
  try {
    const out = (await r.c.render(undefined, { frames: 3 })) as { picture?: { width?: number }; pictures?: unknown[]; note?: string };
    assert.equal(out.pictures?.length, 3);
    assert.equal(out.picture?.width, 1920);
    assert.equal(out.note, '3 frames of "Main" at 0s, 0.75s, 1.5s');
    assert.deepEqual(r.log.filter((l) => l.startsWith("frame:")), ["frame:0", "frame:0.75", "frame:1.5"]);
    const png = await r.c.exportCopy({ format: "png", name: "still" });
    assert.equal(png.path, join(r.home, "Komposit Exports", "still.png"));
    assert.ok(existsSync(png.path!));
    assert.equal((await r.c.save({ mode: "copy" })).error, "After Effects can't save a copy from Komposit; use File > Save a Copy.");
    assert.equal((await r.c.save({ mode: "as" })).error, "After Effects can't save the project as a new file from Komposit; use File > Save As.");
    const saved = await r.c.save({ mode: "overwrite" });
    assert.deepEqual([saved.ok, saved.note], [true, 'Saved the project "My Project.aep".']);
    // Undo is Edit > Undo (command 16), as many steps as asked.
    r.log.length = 0;
    const un = await r.c.undo(undefined, 2);
    assert.deepEqual([un.ok, un.result], [true, 2]);
    assert.deepEqual(r.log.filter((l) => l === "undo" || l.startsWith("command:")), ["undo", "undo"]);
  } finally {
    r.done();
  }
});

test("After Effects: a preview video comes with frames across the work area, so the motion can be checked in the same call", async () => {
  // Seen live (Nov 16): the AI rendered with video: true alone and said "Only one still frame
  // came back to me, so I haven't checked the whole path".
  const r = rig("aftereffects");
  try {
    const out = await r.c.render(undefined, { video: true });
    assert.equal(out.pictures?.length, 4);
    assert.ok(out.videoPath && existsSync(out.videoPath));
    assert.match(out.note ?? "", /^4 frames of "Main" at .*; a preview video of /);
    // Frames asked for are kept, one included.
    assert.equal((await r.c.render(undefined, { video: true, frames: 1 })).pictures?.length, 1);
    assert.equal((await r.c.render(undefined, { video: true, frames: 6 })).pictures?.length, 6);
    assert.equal((await r.c.render()).pictures?.length, 1, "no video: the current frame");
  } finally {
    r.done();
  }
});

test("After Effects 2023 and later: a frame is drawn by waiting on saveFrameToPng's task, not by watching the file", async () => {
  // Seen live (After Effects 2026, Nov 16): saveFrameToPng makes an empty file at once and hands
  // back a task; the frame is drawn only on task.wait() (about 50 ms) or after the script ends,
  // so watching the file waited out its whole limit, about 26 s a frame.
  const r = rig("aftereffects");
  try {
    const comp = r.dom.app.project.activeItem;
    let waits = 0;
    let draws = true;
    comp.saveFrameToPng = (t: number, f: { fsName: string }) => {
      writeFileSync(f.fsName, "");
      r.log.push(`frame:${t}`);
      return { wait: () => { waits++; if (draws) writeFileSync(f.fsName, tinyPng(1920, 1080)); } };
    };
    const out = await r.c.render(undefined, { frames: 3 });
    assert.equal(waits, 3);
    assert.deepEqual(out.pictures?.map((p) => [p.width, p.height]), [[1920, 1080], [1920, 1080], [1920, 1080]]);
    const png = await r.c.exportCopy({ format: "png", name: "still" });
    assert.equal(png.ok, true);
    assert.equal(waits, 4);
    assert.ok(readFileSync(png.path!).length > 0);
    // A frame that comes back empty is an error, never an empty picture or file.
    draws = false;
    await assert.rejects(r.c.render(), /Frame render produced no picture|drew no frame/);
    assert.deepEqual(readdirSync(join(r.dir, "scratch")).filter((f) => f.startsWith("ae-render-")), [], "no empty frames left behind");
    const empty = await r.c.exportCopy({ format: "png", name: "empty" });
    assert.equal(empty.ok, false);
    assert.equal(existsSync(join(r.home, "Komposit Exports", "empty.png")), false);
  } finally {
    r.done();
  }
});

test("After Effects: the request's comp by id, whatever the person views; a comp a script makes is reported, never opened in the viewer", async () => {
  // Seen live (Nov 16): a script made a comp without opening it, and render drew the comp that
  // was open before. The comp a request works in is now named by id (DocRef.part), so nothing
  // depends on what the person has open in the viewer, and Komposit never changes the viewer.
  const r = rig("aftereffects");
  try {
    const project = { app: "aftereffects", name: "My Project.aep", path: "/v/My Project.aep" };
    const made = await r.c.run("var c = app.project.items.addComp('Made', 640, 360, 1, 2, 30); return c.name;");
    assert.deepEqual(made.made, { id: "2", name: "Made" }, "reported back");
    assert.equal(r.dom.app.project.activeItem.name, "Main", "the person's viewer is left as it was");
    assert.ok(!r.log.includes("viewer"));
    // The request goes on in it by id: render, export and edits there, while the viewer shows Main.
    const inMade = { ...project, part: { id: "2", name: "Made" } };
    assert.match((await r.c.render(inMade)).note ?? "", /"Made"/);
    assert.match((await r.c.exportCopy({ doc: inMade, format: "png", name: "made" })).note ?? "", /"Made"/);
    assert.equal((await r.c.run("return comp.name;", inMade)).result, "Made");
    // The person opens another comp mid-request: the request's comp is still the one used.
    r.dom.app.project.activeItem = r.dom.app.project.item(2);
    const inMain = { ...project, part: { id: "1", name: "Main" } };
    assert.equal((await r.c.run("return comp.name;", inMain)).result, "Main");
    assert.match((await r.c.render(inMain)).note ?? "", /"Main"/);
    assert.equal(JSON.parse((await r.c.inspect(inMain)).text).comp.name, "Main");
    // By name works too; a comp that's gone is said plainly, nothing else is used.
    assert.equal((await r.c.run("return comp.name;", { ...project, part: { name: "Main" } })).result, "Main");
    const gone = await r.c.run("return comp.name;", { ...project, part: { id: "99", name: "Old" } });
    assert.equal(gone.ok, false);
    assert.match(gone.error ?? "", /^The comp Old isn't in the project anymore\. Hint: /);
    // A precomp (a layer in the request's comp) isn't reported.
    const pre = await r.c.run("var p = app.project.items.addComp('Pre', 640, 360, 1, 2, 30); p.usedIn = [comp]; return 1;", inMain);
    assert.equal(pre.made, undefined);
    // A script that opens one of its comps itself: that one; else the newest.
    assert.equal((await r.c.run("var a = app.project.items.addComp('A', 640, 360, 1, 2, 30); app.project.items.addComp('B', 640, 360, 1, 2, 30); a.openInViewer(); return 1;")).made?.name, "A");
    assert.equal((await r.c.run("app.project.items.addComp('C', 640, 360, 1, 2, 30); app.project.items.addComp('D', 640, 360, 1, 2, 30); return 1;")).made?.name, "D");
    // A script that makes no comp reports nothing, even when it fails.
    assert.equal((await r.c.run("throw new Error('no');")).made, undefined);
    // Without a part (an old caller): the comp in the viewer, as before.
    r.dom.app.project.activeItem = r.dom.app.project.item(1);
    assert.equal((await r.c.run("return comp.name;")).result, "Main");
  } finally {
    r.done();
  }
});

test("After Effects: a dialog, blocked file writes, not open, still starting: each a plain sentence", async () => {
  const modal = new Map([[1, { w: 1900, h: 1000, layer: 0 }], [2, { w: 420, h: 180, layer: 8 }]]);
  const main = new Map([[1, { w: 1900, h: 1000, layer: 0 }]]);

  // A dialog up before the script: held back, never sent.
  const before = rig("aftereffects", { windows: () => modal });
  try {
    const r = await before.c.run("return 1;");
    assert.equal(r.ok, false);
    assert.match(r.error || "", /^After Effects is showing a dialog, and won't run scripts until it's closed\./);
    assert.equal(before.transport.calls.length, 0);
    assert.equal(before.incidents[0].kind, "blocked");
  } finally {
    before.done();
  }

  // A dialog that comes up as the script is sent: DoScript returns at once, no result file.
  let sent = false;
  const during = rig("aftereffects", { windows: () => (sent ? modal : main), drop: () => (sent = true) });
  try {
    const r = await during.c.run("return 1;");
    assert.equal(r.error, "After Effects is showing a dialog, and won't run scripts until it's closed. Close it in After Effects, then try again.");
  } finally {
    during.done();
  }

  // No dialog, no result file: the scripting setting is off.
  const writes = rig("aftereffects", { drop: () => true });
  try {
    const r = await writes.c.run("return 1;");
    assert.equal(r.error, 'After Effects ran the script but couldn\'t hand the result back. In After Effects, open Settings > Scripting & Expressions and turn on "Allow Scripts to Write Files and Access Network", then try again.');
  } finally {
    writes.done();
  }
  const winWrites = rig("aftereffects", { drop: () => true, platform: "win" });
  try {
    assert.match((await winWrites.c.run("return 1;")).error || "", /open Edit > Preferences > Scripting & Expressions and turn on/);
  } finally {
    winWrites.done();
  }

  const closed = rig("aftereffects", { running: { aftereffects: false } });
  try {
    assert.equal((await closed.c.run("return 1;")).error, "After Effects isn't open. Open it, wait for it to finish starting, then try again.");
  } finally {
    closed.done();
  }
});

test("automation denied: a plain sentence, no incident, and status says why", async () => {
  const denied = () => osascriptFailure('application "Adobe Illustrator"', 1, "execution error: Not authorized to send Apple events to Adobe Illustrator. (-1743)");
  const r = rig("illustrator", { fail: denied, automation: { illustrator: "denied" } });
  try {
    const res = await r.c.run("return 1;");
    assert.deepEqual(res, { ok: false, error: "Komposit is not allowed to control Illustrator. Turn it on in System Settings > Privacy & Security > Automation.", logs: [] });
    assert.equal(r.incidents.length, 0);
    const s = await r.c.status();
    assert.equal(s.ready, false);
    assert.equal(s.reason, "Komposit isn't allowed to control Illustrator. Turn it on in System Settings > Privacy & Security > Automation.");
    await assert.rejects(r.c.inspect(), /^Error: Komposit is not allowed to control Illustrator/);
    const exp = await r.c.exportCopy({ format: "png", name: "x" });
    assert.match(exp.error || "", /^Komposit is not allowed to control Illustrator/);
  } finally {
    r.done();
  }
  // A timeout is an incident and reads plainly.
  const slow = rig("photoshop", { fail: () => osascriptFailure('application id "com.adobe.Photoshop"', 1, "AppleEvent timed out. (-1712)") });
  try {
    const res = await slow.c.run("return 1;");
    assert.equal(res.error, "Photoshop didn't answer in time. If it's showing a dialog, close it. The step may still finish inside the app, so check before retrying.");
    assert.equal(slow.incidents[0].kind, "timeout");
  } finally {
    slow.done();
  }
});

test("status: not installed, not open, After Effects' dialog and scripting setting, ready", async () => {
  const cases: [Parameters<typeof rig>[0], FakeTransportOptions, boolean, string | undefined][] = [
    ["illustrator", { running: { illustrator: false }, installed: { illustrator: null } }, false, "Illustrator isn't installed on this Mac."],
    ["photoshop", { running: { photoshop: false } }, false, "Photoshop isn't open."],
    ["photoshop", {}, true, undefined],
    // Seen live (Nov 16): Photoshop opened with "Scratch Disk Low" up, every script waited behind
    // it, and status said ready.
    ["photoshop", { windows: () => new Map([[1, { w: 1440, h: 822, layer: 0 }], [2, { w: 222, h: 294, layer: 8, title: "Scratch Disk Low" }]]) }, false, "Photoshop is showing a dialog (Scratch Disk Low), and won't run scripts until it's closed."],
    // Illustrator keeps an untitled modal-layer window up all day (Nov 16: the AI was told it was
    // blocked, and wouldn't work): a dialog only when the system lists one.
    ["illustrator", { windows: () => new Map([[1, { w: 1440, h: 822, layer: 0 }], [2, { w: 256, h: 299, layer: 8 }]]) }, true, undefined],
    ["illustrator", { windows: () => new Map([[1, { w: 1440, h: 822, layer: 0 }], [2, { w: 420, h: 180, layer: 8 }]]), dialogs: () => ({ dialogs: [{ title: "", text: ["Could not complete the request."], buttons: ["OK"] }] }) }, false, "Illustrator is showing a dialog, and won't run scripts until it's closed."],
    ["aftereffects", { windows: () => new Map([[1, { w: 1900, h: 1000, layer: 0 }], [2, { w: 400, h: 200, layer: 8 }]]) }, false, "After Effects is showing a dialog, and won't run scripts until it's closed."],
    ["aftereffects", { aeWrites: false }, false, 'After Effects\' scripting setting is off: turn on "Allow Scripts to Write Files and Access Network" in Settings > Scripting & Expressions.'],
    ["aftereffects", { uptime: 2 }, false, "After Effects is still starting. Give it a moment, then try again."],
    ["aftereffects", {}, true, undefined],
  ];
  for (const [app, fake, ready, reason] of cases) {
    const r = rig(app, fake);
    try {
      const s = await r.c.status();
      assert.equal(s.ready, ready, `${app} ${JSON.stringify(reason)}`);
      assert.equal(s.reason, reason);
      assert.equal(r.transport.calls.length, 0, "status never sends a script");
    } finally {
      r.done();
    }
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAIN_WIN = { w: 1440, h: 875, layer: 0 };
const DIALOG_WIN = { w: 420, h: 180, layer: 8, title: "Adobe Photoshop" };

/** Photoshop with a dialog that comes up (or is up) as the test says, a watcher that looks every
 *  few ms, and what was pressed. */
function dialogRig(o: { upAtStart?: boolean; personIn?: boolean; buttons?: string[]; answer?: (how: { button?: string; key?: string }) => { ok: boolean; reason?: string } } = {}) {
  let up = !!o.upAtStart;
  const pressed: unknown[] = [];
  const transport = createFakeTransport({
    windows: () => new Map<number, any>(up ? [[1, MAIN_WIN], [9, DIALOG_WIN]] : [[1, MAIN_WIN]]),
    dialogs: () => ({ dialogs: up ? [{ title: "Adobe Photoshop", text: ["Save changes to “poster.psd” before closing?"], buttons: o.buttons ?? ["Don’t Save", "Cancel", "Save"] }] : [] }),
    answer: (_app, how) => (pressed.push(how), o.answer ? o.answer(how) : how.button === "Cancel" || how.button === "OK" ? { ok: true } : { ok: false, reason: "no such button" }),
  });
  const kit = createKit("mac", { transport, scratchDir: keep(mkdtempSync(join(tmpdir(), "kp-dlg-"))), personIn: () => !!o.personIn });
  const c = createPhotoshop(kit);
  // A step: watch, (the dialog comes up during it unless it was already up), look twice.
  const step = async () => {
    const seen: (string | null)[] = [];
    const stop = kit.dialogs.watch("photoshop", (t) => seen.push(t), { startAfterMs: 5, everyMs: 5 });
    await sleep(10);
    up = true;
    await sleep(40);
    stop();
    return seen;
  };
  return { kit, c, pressed, step, close: () => { up = false; } };
}

test("dialogs: read what it says; the agent may cancel or acknowledge one its step caused, not save or discard", async () => {
  const r = dialogRig();
  const seen = await r.step();
  assert.match(String(seen[0]), /^Photoshop is showing a dialog \(Adobe Photoshop\)/);
  const read = await r.c.dialog!("read");
  assert.equal(read.ok, true);
  assert.equal(read.theirs, undefined, "a dialog the step caused");
  assert.deepEqual(read.buttons, ["Don’t Save", "Cancel", "Save"]);
  assert.match(read.text || "", /^Photoshop is showing a dialog \(Adobe Photoshop\)/);
  const save = await r.c.dialog!("press", "Don’t Save");
  assert.equal(save.ok, false);
  assert.match(save.text || "", /it's the person's to press/);
  assert.deepEqual(await r.c.dialog!("press", "Cancel"), { ok: true, text: `Pressed "Cancel" in Photoshop's dialog.` });
  assert.match((await r.c.dialog!("press", "Retry")).text || "", /has no "Retry" button\. Its buttons: Don’t Save, Cancel, Save\./);
  // Esc is the Cancel button when there is one: no key, nothing brought forward.
  assert.deepEqual(await r.c.dialog!("press", "escape"), { ok: true, text: `Pressed "Cancel" in Photoshop's dialog.` });
  assert.deepEqual(r.pressed, [{ button: "Cancel" }, { button: "Retry" }, { button: "Cancel" }]);
});

test("dialogs: the person's own dialog is theirs: the step waits on it, and nothing is pressed in it", async () => {
  // Up before the step started (Image Size, Save As... the person opened).
  const before = dialogRig({ upAtStart: true });
  const seen = await before.step();
  assert.deepEqual(seen, ["Waiting for you to close “Adobe Photoshop” in Photoshop: “Save changes to “poster.psd” before closing?”"]);
  const read = await before.c.dialog!("read");
  assert.equal(read.theirs, true);
  assert.match(read.text || "", /It's the person's \(it was up before Komposit's step, or came up while they were working in Photoshop\): don't press anything in it/);
  for (const b of ["Cancel", "OK", "escape"]) {
    const r = await before.c.dialog!("press", b);
    assert.equal(r.ok, false);
    assert.equal(r.theirs, true);
    assert.match(r.text || "", /^Photoshop's dialog is the person's/);
  }
  assert.deepEqual(before.pressed, [], "nothing pressed, no key sent");

  // Came up while the person was working in Photoshop.
  const working = dialogRig({ personIn: true });
  assert.deepEqual(await working.step(), ["Waiting for you to close “Adobe Photoshop” in Photoshop: “Save changes to “poster.psd” before closing?”"]);
  assert.equal((await working.c.dialog!("press", "Cancel")).theirs, true);
  assert.deepEqual(working.pressed, []);

  // Never seen by a step (it came up between steps): theirs too.
  const unseen = dialogRig({ upAtStart: true });
  assert.equal((await unseen.c.dialog!("read")).theirs, true);
  assert.equal((await unseen.c.dialog!("press", "OK")).ok, false);

  // A step's own dialog that has gone, and another that came up unseen: theirs.
  const gone = dialogRig();
  await gone.step();
  assert.equal(await gone.kit.dialogs.whose("photoshop"), "komposit");
  gone.close();
  assert.equal(await gone.kit.dialogs.whose("photoshop"), "person");
});

test("dialogs: Esc is only sent as a key to an app that's already in front, never by bringing it forward", async () => {
  const r = dialogRig({ buttons: ["OK"], answer: (how) => (how.key ? { ok: false, reason: "not in front" } : { ok: true }) });
  await r.step();
  const esc = await r.c.dialog!("press", "escape");
  assert.equal(esc.ok, false);
  assert.match(esc.text || "", /^Komposit only sends Esc to Photoshop when it's already in front, and it isn't/);
  assert.deepEqual(r.pressed, [{ key: "escape" }]);
  assert.deepEqual((r.kit.transport as any).activated, [], "the app was never brought forward");
});

test("After Effects: a step waits for a dialog that's up (the person's), then runs; a read doesn't wait", async () => {
  let up = true;
  const modal = new Map([[1, { w: 1900, h: 1000, layer: 0 }], [2, { w: 420, h: 180, layer: 8 }]]);
  const main = new Map([[1, { w: 1900, h: 1000, layer: 0 }]]);
  const r = rig("aftereffects", { windows: () => (up ? modal : main), dialogs: () => ({ dialogs: up ? [{ title: "Composition Settings", text: [], buttons: ["OK", "Cancel"] }] : [] }) });
  try {
    // A read (no onWait): refused at once, as before.
    const read = await r.c.run("return 1;");
    assert.match(read.error || "", /^After Effects is showing a dialog/);
    // A step: waits, says so, and runs once the person closes it.
    const waits: (string | null)[] = [];
    setTimeout(() => { up = false; }, 1500);
    const t0 = Date.now();
    const res = await r.c.run("return 2;", undefined, { onWait: (w) => waits.push(w) });
    assert.equal(res.result, 2, res.error);
    assert.ok(Date.now() - t0 >= 1400);
    assert.equal(waits[0], "Waiting for you to close “Composition Settings” in After Effects.");
    assert.equal(waits.at(-1), null);
    assert.equal(r.transport.calls.length, 1, "sent once, after the dialog closed");
  } finally {
    r.done();
  }
});

test("dialog watch: a new window that stays up is reported, and again when it's gone", async () => {
  let wins = new Map([[1, { w: 1440, h: 875, layer: 0 }]]);
  const t = createFakeTransport({ windows: () => wins, dialogs: () => ({ dialogs: [{ title: "", text: ["The file is locked."], buttons: ["OK"] }] }) });
  const seen: (string | null)[] = [];
  const stop = createDialogWatcher(t).watch("illustrator", (text) => seen.push(text), { startAfterMs: 5, everyMs: 5 });
  await new Promise((r) => setTimeout(r, 15));
  wins = new Map([...wins, [9, { w: 480, h: 200, layer: 0 }]]);
  await new Promise((r) => setTimeout(r, 40));
  wins = new Map([[1, { w: 1440, h: 875, layer: 0 }]]);
  await new Promise((r) => setTimeout(r, 40));
  stop();
  assert.deepEqual(seen, ["Illustrator is showing a dialog: “The file is locked.” Its buttons: OK. Answer it and this carries on.", null]);
});

test("dialog watch: a dialog that was already up when the step started is reported too", async () => {
  // Seen live (Nov 16): Photoshop opened with its "Scratch Disk Low" alert up; every script
  // waited behind it for minutes and the step never said why.
  let wins = new Map([[1, { w: 1440, h: 822, layer: 0 }], [7, { w: 222, h: 294, layer: 8 }], [8, { w: 100, h: 100, layer: 3 }]]);
  const t = createFakeTransport({ windows: () => wins, dialogs: () => ({ dialogs: [{ title: "Scratch Disk Low", text: ["The scratch disk is almost full."], buttons: ["OK"] }] }) });
  const seen: (string | null)[] = [];
  const stop = createDialogWatcher(t).watch("photoshop", (text) => seen.push(text), { startAfterMs: 5, everyMs: 5 });
  await new Promise((r) => setTimeout(r, 40));
  wins = new Map([[1, { w: 1440, h: 822, layer: 0 }], [8, { w: 100, h: 100, layer: 3 }]]);
  await new Promise((r) => setTimeout(r, 40));
  stop();
  // Up before the step: the person closes it (Komposit never presses it), and the step says so.
  assert.deepEqual(seen, ["Waiting for you to close “Scratch Disk Low” in Photoshop: “The scratch disk is almost full.”", null]);
});

test("guides: 1.0's recipes verbatim, an index and sections on demand", async () => {
  const m = loadConnectors("mac", { transport: createFakeTransport(), scratchDir: keep(mkdtempSync(join(tmpdir(), "kp-guide-"))) });
  const ai = await m.get("illustrator")!.guide!();
  assert.match(ai, /^Illustrator ExtendScript \(ES3\) — correct patterns/);
  assert.match(ai, /- duplicating: Duplicate artwork: use item\.duplicate\(\)/);
  assert.match(await m.get("illustrator")!.guide!("duplicating"), /NEVER copy\(\)\/paste\(\)/);
  assert.match(await m.get("photoshop")!.guide!("text"), /PostScript name/);
  assert.match(await m.get("aftereffects")!.guide!("easing"), /KeyframeEase\(0, 75\)/);

  // Every recipe line of 1.0's guidance.mjs is in the app's guide.md, word for word.
  const legacy = join(HERE, "..", "legacy", "companion", "harness", "guidance.mjs");
  if (!existsSync(legacy)) return;
  const src = readFileSync(legacy, "utf8").replace(/\\`/g, "`");
  const section = (app: string) => {
    const m = new RegExp(`\\n  ${app}: \`([\\s\\S]*?)\`,\\n`).exec(src);
    return m ? m[1] : "";
  };
  const envelope = /export const ENVELOPE = `([\s\S]*?)`;/.exec(src)![1];
  // Lines about 1.0's listen tool stay out: v2 has no listen tool (an AI reading them would
  // call a tool that isn't there).
  const v2Has = (l: string) => !/\blisten tool\b/i.test(l);
  for (const app of ["illustrator", "photoshop", "aftereffects"]) {
    const guide = readFileSync(join(HERE, app, "guide.md"), "utf8");
    const lines = [...section(app).split("\n"), ...envelope.split("\n")].filter((l) => l.startsWith("- ") && v2Has(l));
    assert.ok(lines.length > 5, app);
    for (const l of lines) assert.ok(guide.includes(l), `${app} guide is missing: ${l.slice(0, 80)}`);
  }
});

test("guides: nothing about tools v2 doesn't have (After Effects had 1.0's listen tool)", async () => {
  const m = loadConnectors("mac", { transport: createFakeTransport(), scratchDir: keep(mkdtempSync(join(tmpdir(), "kp-guide-"))) });
  for (const app of ["illustrator", "photoshop", "aftereffects"]) {
    const all = await m.get(app)!.guide!("all");
    assert.doesNotMatch(all, /\blisten\b|K\.heard/i, `${app}'s guide mentions listening`);
    assert.doesNotMatch(await m.get(app)!.guide!(), /- listening:/, `${app}'s guide index lists listening`);
  }
});

test("selection summaries: Illustrator text range and nested items; Photoshop layers and marquee; After Effects keys", () => {
  const text = { doc: "a.ai", activeArtboard: "Front", kind: "text", text: "Anaerobic", length: 9, frameText: "Natural Anaerobic", frameRef: "doc.layers[0].pageItems[2]", font: "Didot", size: 24 };
  assert.match(aiSummary(text), /Editing text: "Anaerobic" is selected \(9 characters\) inside the text frame "Natural Anaerobic", Didot 24pt\. Change only this range/);
  const items = {
    doc: "a.ai",
    activeArtboard: "Front",
    kind: "items",
    count: 3,
    artboards: ["Front", "Back"],
    items: [
      { ref: "doc.layers[0].pageItems[0].pageItems[1]", type: "PathItem", name: "Photo", bounds: [0, 0, 10, -10], w: 10, h: 10, layer: "Art", artboard: "Front", inGroup: "Badge", insideClippingMask: true },
      { ref: "doc.layers[0].pageItems[1]", type: "PathItem", name: "", bounds: [0, 0, 10, -10], w: 10, h: 10, layer: "Art", artboard: "Back", selectedPoints: "2 of 10" },
    ],
  };
  const s = aiSummary(items);
  assert.match(s, /3 items selected across artboards "Front", "Back"/);
  assert.match(s, /inside group "Badge" \(a clipping mask\)/);
  assert.match(s, /only 2 of 10 points selected/);
  assert.match(s, /…and 1 more/);
  const ps = {
    doc: "p.psd",
    width: 800,
    height: 600,
    count: 2,
    marquee: [1, 2, 3, 4],
    layers: [
      { ref: "0", name: "Headline", type: "layer", kind: "TEXT", visible: true, text: "Spring", font: "Didot", size: 40, bounds: [1, 2, 3, 4] },
      { ref: "1/1", name: "Photo", type: "layer", kind: "NORMAL", visible: true, inGroup: "Hero", mask: true, bounds: [0, 0, 0, 0] },
    ],
  };
  const p = psSummary(ps);
  assert.match(p, /2 layers selected/);
  assert.match(p, /pixel layer "Photo", in group "Hero", has a layer mask, empty/);
  assert.match(p, /marquee selection covers \[1, 2, 3, 4\]px/);
  const ae = {
    kind: "comp",
    comp: { name: "Main", w: 1920, h: 1080, duration: 10, fps: 30, time: 2.5, workArea: [0, 5] },
    layers: [],
    props: [{ layer: "Title", path: "Transform > Position", ref: 'comp.layer(1).property("ADBE Transform Group").property("ADBE Position")', keys: 3, selectedKeys: 2, selectedKeyTimes: [0.5, 1.2] }],
  };
  const a = aeSummary(ae);
  assert.match(a, /playhead at 2.5s; work area 0–5s/);
  assert.match(a, /"Title" > Transform > Position, 3 keyframes, 2 selected at 0.5s, 1.2s/);
});

test("Illustrator PDF: made from a throwaway copy of the saved file; the person's document isn't repointed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kp-pdf-"));
  try {
    const src = join(dir, "poster.ai");
    writeFileSync(src, "the person's artwork");
    const log: string[] = [];
    const File = fakeFileClass();
    const doc = {
      name: "poster.ai",
      fullName: { fsName: src },
      saved: true,
      documentColorSpace: "RGB",
      artboards: Object.assign([{ name: "Front", artboardRect: [0, 200, 100, 0] }], { getActiveArtboardIndex: () => 0 }),
      saveAs() {
        throw new Error("saveAs on the person's document");
      },
    };
    let active: unknown = doc;
    const app = {
      userInteractionLevel: "DISPLAY",
      documents: [doc],
      PDFPresetsList: ["[High Quality Print]", "[PDF/X-4:2008]"],
      get activeDocument() {
        return active;
      },
      set activeDocument(d) {
        active = d;
      },
      open(f: { fsName: string }) {
        log.push(`open:${f.fsName === src ? "original" : "copy"}`);
        return {
          saveAs(out: { fsName: string }, o: { pDFPreset: string; trimMarks: boolean }) {
            writeFileSync(out.fsName, "%PDF");
            log.push(`pdf:${o.pDFPreset}:${o.trimMarks}`);
          },
          close() {
            log.push("close copy");
          },
        };
      },
    };
    const globals = () => ({
      app,
      File,
      $: { sleep() {} },
      UserInteractionLevel: { DONTDISPLAYALERTS: "DONT" },
      PDFSaveOptions: class {},
      PageMarksTypes: { Roman: "roman" },
      PDFTrimMarkWeight: { TRIMMARKWEIGHT025: 0.25 },
      SaveOptions: { DONOTSAVECHANGES: "no" },
      DocumentColorSpace: { RGB: "RGB", CMYK: "CMYK" },
    });
    const c = createIllustrator(createKit("mac", { transport: createFakeTransport({ globals }), scratchDir: join(dir, "s"), home: dir }));
    const r = await c.exportCopy({ format: "pdf", options: { bleedMm: 3 } });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.path, join(dir, "Komposit Exports", "poster.pdf"));
    assert.equal(readFileSync(r.path!, "utf8"), "%PDF");
    assert.equal(r.sourceUnchanged, true);
    assert.equal(r.note, "PDF (PDF/X-4:2008, 3 mm bleed, crop marks), all 1 artboard, made from the saved file.");
    assert.deepEqual(r.warnings, ["RGB document. PDF/X-4 keeps RGB, but many printers want CMYK; ask yours."]);
    assert.deepEqual(log, ["open:copy", "pdf:[PDF/X-4:2008]:true", "close copy"]);
    assert.equal(readFileSync(src, "utf8"), "the person's artwork");
    assert.equal(app.userInteractionLevel, "DISPLAY");
    const bad = await c.exportCopy({ format: "pdf", options: { preset: "[Nope]" } });
    assert.equal(bad.ok, false);
    assert.match(bad.error || "", /^Unknown PDF preset \[Nope\]\. Available: \[High Quality Print\], \[PDF\/X-4:2008\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Show in: the document stays in front and the app comes forward (Illustrator, Photoshop); After Effects just comes forward", async () => {
  const ai = rig("illustrator");
  try {
    await ai.c.show!({ app: "illustrator", name: "b.ai", path: "/v/b.ai" });
    assert.equal(ai.dom.app.activeDocument.name, "b.ai", "left in front, not put back");
    assert.equal(ai.dom.app.userInteractionLevel, "DISPLAY", "quiet mode is off again");
    assert.deepEqual(ai.transport.activated, ["illustrator"]);
    await assert.rejects(ai.c.show!({ app: "illustrator", name: "c.ai", path: "/v/c.ai" }), /c.ai is not open in Illustrator anymore/);
    assert.deepEqual(ai.transport.activated, ["illustrator"], "nothing comes forward for a document that's gone");
  } finally {
    ai.done();
  }
  const ps = rig("photoshop");
  try {
    await ps.c.show!({ app: "photoshop", name: "Untitled-1", id: "12" });
    assert.equal(ps.dom.app.activeDocument.name, "Untitled-1");
    assert.deepEqual(ps.transport.activated, ["photoshop"]);
  } finally {
    ps.done();
  }
  const ae = rig("aftereffects");
  try {
    await ae.c.show!();
    assert.deepEqual(ae.transport.activated, ["aftereffects"]);
  } finally {
    ae.done();
  }
});
