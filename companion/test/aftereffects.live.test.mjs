// Live After Effects checks: selection, frame strips, the MP4 preview and MP4
// export. Needs After Effects open with an EMPTY, untitled project; the test
// builds its own comp and removes everything it made.
//   KOMPOSIT_LIVE=1 node --test companion/test/aftereffects.live.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as ae from "../bridges/aftereffects.mjs";
import { runViaFile } from "../bridges/extendscript.mjs";

const LIVE = process.env.KOMPOSIT_LIVE === "1";
// The platform layer finds the After Effects that's open (any year; AE_APP overrides).
const APP = "aftereffects";
const OUT = "~/Komposit Exports/komposit-ae-test";
const DIR = join(homedir(), "Komposit Exports", "komposit-ae-test");

async function js(code, timeoutMs = 60000) {
  const r = await runViaFile(APP, code, { timeoutMs });
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

test("After Effects: selection, frames, preview video, MP4 export", { skip: !LIVE, timeout: 900000 }, async () => {
  const start = await js(`return { items: app.project.numItems, file: app.project.file ? 1 : 0, rq: app.project.renderQueue.numItems };`);
  if (start.items || start.file) throw new Error("Open After Effects with an empty, untitled project for this test.");
  rmSync(DIR, { recursive: true, force: true });
  try {
    await js(`app.beginUndoGroup('kp test');
      var c = app.project.items.addComp('KP Test', 640, 360, 1, 3, 30);
      c.bgColor = [0.07, 0.07, 0.07];
      var box = c.layers.addSolid([1, 0.35, 0.12], 'Box', 120, 120, 1);
      var pos = box.property('Transform').property('Position');
      pos.setValueAtTime(0, [100, 180]); pos.setValueAtTime(2.5, [540, 180]);
      var t = c.layers.addText('Komposit');
      c.openInViewer(); c.time = 1.2;
      // New layers and keys come in selected; select exactly the Box's second key.
      try { t.property('Source Text').selected = false; } catch(e){}
      t.selected = false;
      box.selected = true; pos.selected = true; pos.setSelectedAtKey(1, false); pos.setSelectedAtKey(2, true);
      app.endUndoGroup(); return 'ok';`);

    const sel = await ae.selection();
    console.log(sel.summary);
    assert.match(sel.summary, /Comp "KP Test" 640×360, 3s at 30fps; playhead at 1\.2s/);
    assert.match(sel.summary, /solid layer "Box"/);
    assert.match(sel.summary, /"Box" > Transform > Position, 2 keyframes, 1 selected at 2\.5s/);

    const frames = await ae.render({ frames: 4 });
    assert.equal(frames.images.length, 4);
    assert.match(frames.note, /4 frames of "KP Test" at 0s, /);

    const t0 = Date.now();
    const prev = await ae.render({ frames: 1, video: true });
    console.log(`preview video in ${Date.now() - t0} ms: ${prev.video}`);
    assert.ok(prev.video && existsSync(prev.video) && statSync(prev.video).size > 1000, "preview MP4 written");
    rmSync(prev.video, { force: true });

    const mp4 = await ae.exportCopy({ format: "mp4", name: "kp test", outputDir: OUT });
    assert.ok(existsSync(mp4.path) && statSync(mp4.path).size > 1000);
    assert.match(mp4.note, /H\.264 MP4 of "KP Test", 640×360/);
    const png = await ae.exportCopy({ format: "png", name: "kp test", outputDir: OUT });
    assert.ok(existsSync(png.path));

    const after = await js(`return { rq: app.project.renderQueue.numItems };`);
    assert.equal(after.rq, start.rq, "Komposit's render-queue items are removed afterwards");
  } finally {
    await js(`for (var i = app.project.numItems; i >= 1; i--) { try { app.project.item(i).remove(); } catch(e){} } return 'ok';`).catch(() => {});
    if (process.env.KEEP !== "1") rmSync(DIR, { recursive: true, force: true });
  }
});
