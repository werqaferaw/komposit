// The script check's rules, one by one, and the ordinary scripts that must pass untouched.
// Run: node --test toolkit/scriptcheck.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { checkScript, describeFindings, findSaves, maskScript, SCRIPT_REASONS as R } from "./scriptcheck.ts";

const whats = (code: string) => checkScript(code).map((f) => f.what);
const flags = (code: string, what: string) => assert.ok(whats(code).includes(what), `should say "${what}" for:\n${code}\ngot: ${JSON.stringify(whats(code))}`);
const passes = (code: string) => assert.deepEqual(checkScript(code), [], `should pass:\n${code}`);

test("writing files: opened for writing, appending or editing, and written to", () => {
  flags("var f = new File('~/Desktop/notes.txt'); f.open('w'); f.write('hi'); f.close();", R.write);
  flags("var f = File(p);\nf.open(\"a\");", R.write);
  flags("var f = new File(p); f.open('e'); f.seek(0, 2); f.writeln('x');", R.write);
  flags("new File('~/x.txt').open('w')", R.write);
  flags("var out = File.saveDialog('Where?'); out.open('w'); out.write(s); out.close();", R.write);
  // An open() with a mode in a variable still writes when it writes.
  flags("var f = new File(p); f.open(mode); f.writeln(data);", R.write);
  assert.match(checkScript("var f = new File(p);\nf.open('w');")[0]!.snippet, /f\.open\('w'\)/);
});

test("copying files and making folders", () => {
  flags("var src = new File(a); src.copy('~/Desktop/copy.psd');", R.copy);
  flags("File(a).copy(new File(b))", R.copy);
  flags("var d = new Folder('~/Desktop/exports'); if (!d.exists) d.create();", R.mkdir);
  flags("new Folder(Folder.desktop + '/out').create()", R.mkdir);
});

test("the scratch folder (Folder.temp) is fair game, unless the path climbs out of it", () => {
  passes("var t = new File(Folder.temp + '/komposit-notes.txt'); t.open('w'); t.write('x'); t.close();");
  passes("var dir = new Folder(Folder.temp + '/komposit'); dir.create(); var f = new File(dir + '/a.json'); f.open('w'); f.writeln('{}'); f.close();");
  passes("new Folder(Folder.temp.fsName + '/k').create();");
  passes("var src = new File(p); src.copy(Folder.temp + '/backup.ai');");
  flags("var t = new File(Folder.temp + '/../../Desktop/x.txt'); t.open('w');", R.write);
  flags("var t = new File(Folder.temp + '/a.txt'); t = new File('~/Desktop/a.txt'); t.open('w');", R.write);
});

test("saving or exporting to a path named in the code", () => {
  flags("app.activeDocument.saveAs(new File('~/Desktop/poster.ai'));", R.saveTo);
  // Premiere Pro's own ways to write files.
  flags("var s = app.project.activeSequence; s.exportAsMediaDirect('~/Desktop/cut.mp4', preset, 0);", R.saveTo);
  flags("app.enableQE(); qe.project.getActiveSequence().exportFramePNG(tc, '/Users/you/still.png');", R.saveTo);
  flags("app.project.activeSequence.exportAsProject('~/Desktop/copy.prproj');", R.saveTo);
  flags("app.encoder.encodeSequence(seq, out, preset, 0, 1);", R.saveTo);
  flags("var opts = new ExportOptionsPNG24(); doc.exportFile(new File(p), ExportType.PNG24, opts);", R.saveTo);
  flags("doc.exportDocument(f, ExportType.SAVEFORWEB, o);", R.saveTo);
  flags("app.project.save(new File('~/Desktop/a.aep'))", R.saveTo);
  flags("comp.saveFrameToPng(0, new File(p));", R.saveTo);
  flags("doc.saveAs(f, opts, true, Extension.LOWERCASE)", R.saveTo);
  flags("var d = new ActionDescriptor(); executeAction(charIDToTypeID('save'), d, DialogModes.NO);", R.saveTo);
  flags("executeAction(stringIDToTypeID(\"export\"), d, DialogModes.NO)", R.saveTo);
  flags("app.project.renderQueue.render();", R.render);
  flags("app.executeMenuCommand('saveas');", R.menu);
  flags("app.executeMenuCommand(\"close\")", R.menu);
});

test("other apps, other scripts, and code built while running", () => {
  flags("var bt = new BridgeTalk(); bt.target = 'photoshop'; bt.body = 'app.quit()'; bt.send();", R.bridgeTalk);
  flags("app.doScript('Drop shadow', 'Default Actions');", R.doScript);
  flags("app.doAction('Vignette (selection)', 'Default Actions');", R.doAction);
  flags("$.evalFile(new File('~/x.jsx'));", R.evalFile);
  flags("#include \"~/helpers.jsx\"\nmain();", R.evalFile);
  flags("//@include 'lib.jsx'\nmain();", R.evalFile);
  flags("eval('app.' + 'quit()');", R.built);
  flags("var a = 'app.qu', b = 'it()'; eval(a + b);", R.built);
  flags("var f = new Function('return app.activeDocument');", R.built);
  flags("var g = Function('x', 'return x');", R.built);
  flags("app.scheduleTask('alert(1)', 1000, false);", R.built);
  flags("var s = new Socket(); s.open('example.com:80');", R.network);
  flags("app.system('rm -rf ~/Desktop')", R.appSystem);
});

test("the earlier rules still hold", () => {
  const cases: [string, string][] = [
    ["File('~/a.txt').remove()", R.remove],
    ["var list = Folder('~/x').getFiles();\nlist[0].remove();", R.remove],
    ["var s = new File('/tmp/x.command'); s.execute();", R.execute],
    ["var f = new File(p); f.rename('b.txt');", R.rename],
    ["system.callSystem('ls')", R.callSystem],
    ["app.quit()", R.quit],
    ["app.activeDocument.close(SaveOptions.DONOTSAVECHANGES)", R.closeNoSave],
    ["app.activeDocument.close()", R.close],
  ];
  for (const [code, what] of cases) flags(code, what);
});

test("ordinary editing scripts pass", () => {
  const fine = [
    // Illustrator
    "var doc = app.activeDocument;\nvar r = doc.pathItems.rectangle(0, 0, 100, 50);\nr.fillColor = new RGBColor();\nr.fillColor.red = 255;",
    "var doc = app.activeDocument; for (var i = doc.pageItems.length - 1; i >= 0; i--) { if (doc.pageItems[i].hidden) doc.pageItems[i].remove(); }",
    "var g = doc.groupItems.createFromFile(new File(path)); g.position = [0, 0];",
    "var p = doc.placedItems.add(); p.file = new File(path); p.embed();",
    "app.copy(); app.paste(); app.executeMenuCommand('group');",
    "var t = doc.textFrames.add(); t.contents = 'Never eval(this) or saveAs(that)';",
    "$.writeln('saved to ' + doc.fullName); $.write('done');",
    "// we would call doc.saveAs(file) here, but the save tool does that\nvar n = doc.layers.length; n",
    "/* app.quit(); BridgeTalk */ doc.layers[0].name = 'Logo';",
    "var parts = s.split('/'); var ratio = w / h; var re = /eval\\(/g; re.test(x);",
    // Photoshop
    "var d = new ActionDescriptor(); d.putPath(charIDToTypeID('null'), new File(path)); executeAction(charIDToTypeID('Plc '), d, DialogModes.NO);",
    "var l = app.activeDocument.artLayers.add(); l.name = 'Shadow'; l.opacity = 40;",
    "app.activeDocument.resizeImage(UnitValue(1200, 'px'), null, 72, ResampleMethod.BICUBIC);",
    "var doc = app.open(new File(path));",
    // After Effects
    "var item = app.project.importFile(new ImportOptions(new File(path))); comp.layers.add(item);",
    "var e = new KeyframeEase(0, 75); prop.setTemporalEaseAtKey(1, [e], [e]);",
    "app.beginUndoGroup('Fade'); var o = layer.opacity; o.setValueAtTime(0, 0); o.setValueAtTime(1, 100); app.endUndoGroup();",
    "comp.layers.addText('hi'); app.project.save();",
    // Reading a file is fine.
    "var f = new File(path); f.open('r'); var s = f.read(); f.close(); s.length",
    "var f = File(p); if (f.exists) { f.encoding = 'UTF-8'; f.open('r'); var t = f.readln(); f.close(); }",
    "var docFile = new File(p); docFile.open('r'); docFile.close();",
    "var files = Folder(dir).getFiles('*.png'); files.length",
  ];
  for (const code of fine) passes(code);
});

test("comments and strings are masked, keeping every index in place", () => {
  const src = "var a = 'x/*y*/z'; // eval(\"q\")\nb = /\"/g; c = 1 / 2; /* gone */ d";
  const { code, bare } = maskScript(src);
  assert.equal(code.length, src.length);
  assert.equal(bare.length, src.length);
  assert.ok(code.includes("'x/*y*/z'"), "strings stay in code");
  assert.ok(!code.includes("eval"), "comments leave code");
  assert.ok(!bare.includes("x/*y*/z") && bare.includes("'       '"), "string insides leave bare");
  assert.ok(bare.includes("c = 1 / 2;"), "a division is not a regular expression");
  assert.ok(!bare.includes("gone"));
  assert.equal(code.split("\n").length, 2);
});

test("saves found by findSaves ignore comments and strings", () => {
  assert.deepEqual(findSaves("// doc.save() later\nalert('save()');"), []);
  assert.equal(findSaves("doc.save();").length, 1);
});

test("several findings read as one plain paragraph", () => {
  const text = describeFindings(checkScript("var f = new File('~/a.txt'); f.open('w'); var b = new BridgeTalk();"), "Illustrator");
  assert.match(text, /^This edit in Illustrator reaches outside the document\. It writes a file on your computer, and sends code to another app \(BridgeTalk\)\.\n/);
});
