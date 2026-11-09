// Live Illustrator checks for export, save and preflight. Needs Illustrator
// running; makes its own throwaway document and closes it, and checks that the
// documents the person had open are left exactly as they were.
//   KOMPOSIT_LIVE=1 node --test companion/test/illustrator.live.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as il from "../bridges/illustrator.mjs";
import { runViaStdout } from "../bridges/extendscript.mjs";

const LIVE = process.env.KOMPOSIT_LIVE === "1";
const APP = 'application "Adobe Illustrator"';
const DIR = join(homedir(), "Komposit Exports", "komposit-live-test");
const OUT = "~/Komposit Exports/komposit-live-test";

async function js(code) {
  const r = await runViaStdout(APP, code, { timeoutMs: 120000 });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
const snapAll = () =>
  js(`var a=[]; for (var i=0;i<app.documents.length;i++){ var d=app.documents[i], p=null; try{p=d.fullName.fsName;}catch(e){} a.push({name:d.name,path:p,saved:d.saved}); }
      return { active: app.documents.length ? app.activeDocument.name : null, docs: a };`);
const snapActive = () => js(`var d=app.activeDocument, p=null; try{p=d.fullName.fsName;}catch(e){} return {name:d.name,path:p,saved:d.saved};`);
const isPdf = (p) => readFileSync(p).subarray(0, 5).toString() === "%PDF-";
// Close the test's own document without saving and without any alert.
const CLOSE_ACTIVE = `var __ui=app.userInteractionLevel; app.userInteractionLevel=UserInteractionLevel.DONTDISPLAYALERTS;
  try { app.activeDocument.close(SaveOptions.DONOTSAVECHANGES); } finally { app.userInteractionLevel=__ui; } return 'ok';`;

test("Illustrator: export, save and preflight leave the open document alone", { skip: !LIVE, timeout: 600000 }, async () => {
  rmSync(DIR, { recursive: true, force: true });
  const before = await snapAll();
  let made = false;
  try {
    await js(`var __ui=app.userInteractionLevel; app.userInteractionLevel=UserInteractionLevel.DONTDISPLAYALERTS;
      var d = app.documents.add(DocumentColorSpace.RGB, 400, 300);
      var a = d.artboards[0].artboardRect, X = a[0], Y = a[1];   // left, top (y runs up)
      d.artboards.add([X+450, Y, X+850, Y-300]); d.artboards[1].name = 'Back';
      var L = d.layers[0]; L.name = 'Art';
      var c = new RGBColor(); c.red=255; c.green=90; c.blue=31;
      var r = L.pathItems.rectangle(Y-20, X+20, 120, 80); r.fillColor = c;
      var edge = L.pathItems.rectangle(Y-200, X+340, 120, 80); edge.fillColor = c;
      var t = L.textFrames.add(); t.contents = 'Komposit'; t.textRange.characterAttributes.size = 36; t.left = X+30; t.top = Y-130;
      var S = L.layers.add(); S.name = 'Sub'; S.pathItems.ellipse(Y-20, X+200, 60, 60);
      var H = d.layers.add(); H.name = 'Hidden'; H.pathItems.rectangle(Y-30, X+500, 100, 100); H.visible = false; H.locked = true;
      app.userInteractionLevel=__ui; return d.name;`);
    made = true;
    const doc0 = await snapActive();
    assert.equal(doc0.saved, false, "test doc starts with unsaved changes");

    // PDF from an unsaved document: rebuilt copy.
    const p1 = await il.exportCopy({ format: "pdf", name: "live", outputDir: OUT });
    assert.ok(existsSync(p1.path) && isPdf(p1.path), "wrote a PDF");
    assert.equal(p1.documentUnchanged, true);
    assert.match(p1.note, /PDF\/X-4:2008, 3 mm bleed, crop marks/);
    assert.match(p1.note, /unsaved state/);
    assert.ok(p1.warnings.some((w) => /RGB/.test(w)), "warns about RGB");
    assert.deepEqual(await snapActive(), doc0, "open doc unchanged after PDF export");

    // Same name again: a new file, never an overwrite.
    const p2 = await il.exportCopy({ format: "pdf", name: "live", outputDir: OUT, preset: "[Smallest File Size]", bleedMm: 0, cropMarks: false });
    assert.equal(p2.path, join(DIR, "live 2.pdf"));
    assert.match(p2.note, /no bleed, no crop marks/);

    const png = await il.exportCopy({ format: "png", name: "live", outputDir: OUT });
    assert.ok(existsSync(png.path) && png.path.endsWith("live.png"));

    // Preflight sees the edge-crossing item and the hidden layer.
    const pf = await il.preflight();
    assert.equal(pf.info.colorMode, "RGB");
    assert.equal(pf.info.artboards.length, 2);
    assert.equal(pf.info.itemsCrossingEdge, 1);
    assert.equal(pf.info.itemsOffArtboard, 0);
    assert.ok(pf.warnings.some((w) => /Hidden layers/.test(w)));
    assert.deepEqual(await snapActive(), doc0, "preflight is read-only");

    // Save a copy of the unsaved doc.
    const c1 = await il.saveDocument({ mode: "copy", name: "live copy", outputDir: OUT });
    assert.ok(existsSync(c1.path) && c1.path.endsWith(".ai"));
    assert.deepEqual(await snapActive(), doc0, "open doc unchanged after save-a-copy");

    // Overwrite on a never-saved doc is refused.
    await assert.rejects(il.saveDocument({ mode: "overwrite" }), /never been saved/);

    // Now give the test doc a real file, then the saved-file paths.
    const src = join(DIR, "source.ai");
    // Alerts off and explicit options, as Komposit's own saves do: a bare
    // saveAs of a new document can sit behind a dialog nobody sees.
    await js(`var __ui=app.userInteractionLevel; app.userInteractionLevel=UserInteractionLevel.DONTDISPLAYALERTS;
      try { app.activeDocument.saveAs(new File(${JSON.stringify(src)}), new IllustratorSaveOptions()); } finally { app.userInteractionLevel=__ui; }
      return 'ok';`);
    const doc1 = await snapActive();
    assert.equal(doc1.saved, true);
    // Straight after a save: waits for the background save, then copies the file.
    const p3 = await il.exportCopy({ format: "pdf", name: "from-saved", outputDir: OUT });
    assert.match(p3.note, /from the saved file/);
    assert.deepEqual(await snapActive(), doc1);
    const c2 = await il.saveDocument({ mode: "copy", outputDir: OUT });
    assert.ok(c2.path.endsWith("source copy.ai"));

    // Overwrite saves the pending change into the file.
    await js(`var d=app.activeDocument, A=d.layers.getByName('Art'); d.activeLayer=A; A.pathItems.rectangle(-250, 20, 40, 40); return 'ok';`);
    assert.equal((await snapActive()).saved, false);
    const o = await il.saveDocument({ mode: "overwrite" });
    assert.equal(o.path, src);
    assert.equal((await snapActive()).saved, true);
  } finally {
    if (made) await js(CLOSE_ACTIVE).catch(() => {});
    if (before.active) await js(`app.activeDocument = app.documents.getByName(${JSON.stringify(before.active)}); return 'ok';`).catch(() => {});
    if (process.env.KEEP !== "1") rmSync(DIR, { recursive: true, force: true });
  }
  assert.deepEqual(await snapAll(), before, "the person's documents are exactly as they were");
});

test("Illustrator: selection reads the awkward real-world cases", { skip: !LIVE, timeout: 300000 }, async () => {
  const before = await snapAll();
  let made = false;
  try {
    await js(`var __ui=app.userInteractionLevel; app.userInteractionLevel=UserInteractionLevel.DONTDISPLAYALERTS;
      var d = app.documents.add(DocumentColorSpace.RGB, 400, 300);
      var a = d.artboards[0].artboardRect, X = a[0], Y = a[1];
      d.artboards.add([X+450, Y, X+850, Y-300]); d.artboards[0].name = 'Front'; d.artboards[1].name = 'Back';
      var L = d.layers[0]; L.name = 'Art';
      var g = L.groupItems.add(); g.name = 'Badge';
      var photo = g.pathItems.rectangle(Y-20, X+20, 200, 150); photo.name = 'Photo';
      var mask = g.pathItems.ellipse(Y-30, X+40, 120, 120); mask.name = 'Mask';
      mask.move(g, ElementPlacement.PLACEATBEGINNING); mask.clipping = true; g.clipped = true;
      var star = L.pathItems.star(X+300, Y-200, 40, 20, 5); star.name = 'Star';
      var t = L.textFrames.add(); t.contents = 'Natural Anaerobic'; t.left = X+30; t.top = Y-220; t.name = 'Title';
      var back = L.pathItems.rectangle(Y-50, X+500, 80, 80); back.name = 'BackBox';
      app.userInteractionLevel=__ui; return 'ok';`);
    made = true;

    await js(`app.activeDocument.selection = null; return 'ok';`);
    assert.match((await il.selection()).summary, /Nothing is selected/);

    // An item inside a clipping group, picked with Direct Selection.
    await js(`var d=app.activeDocument; d.selection=null; d.layers[0].groupItems.getByName('Badge').pathItems.getByName('Photo').selected = true; return 'ok';`);
    let s = await il.selection();
    assert.match(s.summary, /PathItem "Photo"/);
    assert.match(s.summary, /inside group "Badge" \(a clipping mask\)/);
    const ref = s.data.items[0].ref;
    assert.equal(await js(`var doc=app.activeDocument; return ${ref}.name;`), "Photo", "the ref points straight at the nested item");

    // Only some anchor points of a path.
    await js(`var d=app.activeDocument; d.selection=null; var st=d.layers[0].pathItems.getByName('Star'); st.pathPoints[0].selected=PathPointSelection.ANCHORPOINT; st.pathPoints[1].selected=PathPointSelection.ANCHORPOINT; return 'ok';`);
    s = await il.selection();
    assert.match(s.summary, /only 2 of 10 points selected/);

    // Two items on different artboards.
    await js(`var d=app.activeDocument; d.selection=null; d.layers[0].pathItems.getByName('BackBox').selected=true; d.layers[0].textFrames.getByName('Title').selected=true; return 'ok';`);
    s = await il.selection();
    assert.match(s.summary, /2 items selected across artboards/);
    assert.match(s.summary, /text "Natural Anaerobic"/);

    // A word selected inside a text frame (Type tool).
    const tr = await js(`var d=app.activeDocument; d.selection=null; var tf=d.layers[0].textFrames.getByName('Title');
      var r = tf.textRange.characters[7]; r.length = 9; r.select(); return d.selection ? d.selection.typename : 'none';`);
    if (tr === "TextRange") {
      s = await il.selection();
      assert.match(s.summary, /Editing text: "Anaerobic" is selected \(9 characters\) inside the text frame "Natural Anaerobic"/);
    } else {
      console.log(`  (scripted text-range selection not supported here: ${tr}; skipped that case)`);
    }
  } finally {
    if (made) await js(CLOSE_ACTIVE).catch(() => {});
    if (before.active) await js(`app.activeDocument = app.documents.getByName(${JSON.stringify(before.active)}); return 'ok';`).catch(() => {});
  }
  assert.deepEqual(await snapAll(), before);
});
