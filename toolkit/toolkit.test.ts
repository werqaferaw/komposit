// The open toolkit's rules, ported from core/toolbox/units.test.ts plus what the standalone
// MCP server adds (save finder, script policy wording, its labels).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorManifest } from "../protocol/connector.ts";
import { checkScript, describeFindings, findSaves } from "./scriptcheck.ts";
import { appToolDefs, checkInput, toolList, supportedAppTools, allToolNames, withTarget } from "./tools.ts";
import { inProject, isInside, outputFolder, patternRegex, safeBase, uniquePath, fmtSize } from "./files.ts";
import { doneLabel, stepLabel } from "./labels.ts";
import { agentMayPress } from "./dialogs.ts";

// Temp folders this file makes are removed when the test process ends.
const madeDirs: string[] = [];
process.once("exit", () => { for (const d of madeDirs) rmSync(d, { recursive: true, force: true }); });
const keep = (d: string) => (madeDirs.push(d), d);

const ILLUSTRATOR: ConnectorManifest = { id: "illustrator", label: "Illustrator", maker: "Adobe", platforms: ["mac"], door: "os-script", language: "extendscript", capabilities: { inspect: true, run: true, render: true, export: ["png"], save: ["overwrite"], undo: true, preflight: true, place: true, open: true } };

test("script check: finds what reaches outside the document", () => {
  const cases: [string, RegExp][] = [
    ["File('~/a.txt').remove()", /deletes a file/],
    ["new Folder(p).remove();", /deletes a file/],
    ["var f = File(path);\nf.remove();", /deletes a file/],
    ["var list = Folder('~/x').getFiles();\nlist[0].remove();", /deletes a file/],
    ["var s = new File('/tmp/x.command'); s.execute();", /opens or runs a file/],
    ["var f = new File(p); f.rename('b.txt');", /renames a file/],
    ["system.callSystem('ls')", /runs a command/],
    ["app.quit()", /quits the app/],
    ["app.activeDocument.close(SaveOptions.DONOTSAVECHANGES)", /without saving/],
    ["app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)", /without saving/],
    ["app.activeDocument.close()", /closes a document/],
  ];
  for (const [code, want] of cases) {
    const found = checkScript(code);
    assert.ok(found.length, `should flag: ${code}`);
    assert.match(found.map((f) => f.what).join(";"), want, code);
  }
});

test("script check: ordinary document work is left alone", () => {
  const fine = [
    "app.activeDocument.pageItems[0].remove();",
    "var layer = doc.layers[0]; layer.remove();",
    "var p = doc.placedItems.add(); p.file = new File(path); p.embed();",
    "comp.layers.addText('hi'); app.project.save();",
    "var item = sel[i]; item.remove();",
  ];
  for (const code of fine) assert.deepEqual(checkScript(code), [], code);
});

test("save finder: scripts that save are found, ordinary work is not", () => {
  for (const code of ["app.project.save();", "doc.saveAs(new File(p), opts);", "app.activeDocument.saveAs(f, o, true)", "doc . save ( )", "doc.close(SaveOptions.SAVECHANGES)", "app.project.close(CloseOptions.SAVE_CHANGES)"]) {
    assert.equal(findSaves(code).length, 1, code);
    assert.equal(findSaves(code)[0]!.what, "saves the document");
  }
  for (const code of ["var saved = doc.saved;", "doc.pathItems.rectangle(0,0,10,10);", "// we never save here", "doc.exportFile(f, ExportType.PNG24)", "doc.close(SaveOptions.DONOTSAVECHANGES)", "app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)"]) {
    assert.deepEqual(findSaves(code), [], code);
  }
});

test("findings read as one plain paragraph", () => {
  const text = describeFindings(checkScript("app.quit()"), "Photoshop");
  assert.match(text, /^This edit in Photoshop reaches outside the document\. It quits the app\./);
});

test("schema check: required, types, enums, nested objects and lists", () => {
  const s = { type: "object", properties: { a: { type: "string" }, n: { type: "number" }, e: { type: "string", enum: ["x", "y"] }, list: { type: "array", items: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } } }, required: ["a"] };
  assert.equal(checkInput(s, { a: "ok" }), null);
  assert.equal(checkInput(s, {}), '"a" is missing');
  assert.equal(checkInput(s, { a: "" }), '"a" is missing');
  assert.equal(checkInput(s, { a: 1 }), '"a" must be text');
  assert.equal(checkInput(s, { a: "x", n: NaN }), '"n" must be a number');
  assert.equal(checkInput(s, { a: "x", e: "z" }), '"e" must be one of x, y');
  assert.equal(checkInput(s, { a: "x", list: "no" }), '"list" must be a list');
  assert.equal(checkInput(s, { a: "x", list: [{}] }), '"list[0].label" is missing');
  assert.equal(checkInput(s, []), "the input must be an object");
});

test("tool list: 1.0's names in a fixed order, app and doc on app tools", () => {
  const supported = supportedAppTools([ILLUSTRATOR]);
  const list = toolList({ mod: "Cmd", appIds: ["illustrator"], supported, multiApp: false, project: true });
  assert.deepEqual(list.map((t) => t.name), ["inspect", "edit", "undo", "render", "export", "save", "preflight", "place", "open", "guide", "ask", "write_file", "make_folder", "copy", "move", "trash", "find_files", "read_file"]);
  assert.ok(!list.some((t) => t.name === "dialog"), "no connector reads dialogs");
  assert.match(list.find((t) => t.name === "save")!.description, /Cmd\+S/);
  assert.equal(allToolNames(supported).length, list.length);
  for (const t of list.filter((x) => x.appScoped)) assert.ok((t.inputSchema as any).properties.app, t.name);
});

test("app tools: the script rule follows the policy; app is required with several apps", () => {
  assert.match(appToolDefs("Cmd").edit!.description, /asks the user first/);
  const refuse = appToolDefs("Ctrl", { scripts: "refuse" });
  assert.match(refuse.edit!.description, /is refused with a plain explanation/);
  assert.match(refuse.save!.description, /Ctrl\+S/);
  const t = withTarget(refuse.export!, { appIds: ["illustrator", "photoshop"], multiApp: true });
  assert.deepEqual((t.inputSchema as any).required, ["format", "app"]);
  assert.deepEqual((t.inputSchema as any).properties.app.enum, ["illustrator", "photoshop"]);
});

test("files: names never collide and paths stay where they belong", () => {
  const dir = keep(realpathSync(mkdtempSync(join(tmpdir(), "kbf-"))));
  writeFileSync(join(dir, "Poster.png"), "");
  writeFileSync(join(dir, "Poster 2.png"), "");
  assert.equal(uniquePath(dir, "Poster", "png"), join(dir, "Poster 3.png"));
  assert.equal(uniquePath(dir, "Poster", "jpg"), join(dir, "Poster.jpg"));
  assert.equal(safeBase("a/b:c.png"), "a-b-c");
  assert.equal(safeBase("  ..  "), "komposit-export");
  const root = join(dir, "p");
  mkdirSync(root);
  assert.equal(inProject(root, "x/y.txt", dir), join(root, "x", "y.txt"));
  assert.equal(inProject(root, "../y.txt", dir), null);
  assert.equal(inProject(root, "", dir), null);
  // A link inside the project can't lead out of it.
  symlinkSync(dir, join(root, "out"));
  assert.equal(inProject(root, "out/Poster.png", dir), null);
  assert.throws(() => outputFolder("/etc", { home: dir, exportDir: join(dir, "E"), projectRoots: [] }), /only writes inside your home folder/);
  assert.equal(outputFolder(undefined, { home: dir, exportDir: join(dir, "E"), projectRoots: [] }), join(dir, "E"));
  assert.equal(outputFolder("~/F", { home: dir, exportDir: join(dir, "E"), projectRoots: [] }), join(dir, "F"));
  assert.ok(isInside(dir, join(dir, "a")));
  assert.ok(!isInside(dir, dir + "-other"));
});

test("patterns and sizes", () => {
  assert.ok(patternRegex("*.ai").test("logo.ai"));
  assert.ok(!patternRegex("*.ai").test("x/logo.ai"));
  assert.ok(patternRegex("**/poster*").test("a/b/poster-final.psd"));
  assert.ok(patternRegex("brief").test("docs/Brief.md"));
  assert.equal(fmtSize(1), "1 byte");
  assert.equal(fmtSize(2_500_000), "2.5 MB");
});

test("labels are plain sentences", () => {
  assert.equal(stepLabel("mcp__komposit__inspect"), "Looking at the document");
  assert.equal(stepLabel("edit", { explanation: "make the title red." }), "Make the title red");
  assert.equal(stepLabel("place", { path: "/a/logo.png" }, "Photoshop"), "Bringing logo.png into Photoshop");
  assert.equal(stepLabel("new_document"), "Making a new document");
  assert.equal(doneLabel("export", {}, true), "The export didn't work");
  assert.equal(doneLabel("save", { mode: "copy" }), "Saved a copy");
  assert.equal(doneLabel("trash", { paths: ["a", "b"] }), "Moved 2 items to the Trash");
  assert.equal(doneLabel("apps"), "Checked the apps");
});

test("dialog buttons the AI may press", () => {
  for (const b of ["OK", "Cancel", "Continue", "Close"]) assert.ok(agentMayPress(b), b);
  for (const b of ["Don't Save", "Save", "Discard", "Replace", "Delete", "Quit", ""]) assert.ok(!agentMayPress(b), b);
});
