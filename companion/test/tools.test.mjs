// Tool rules that don't need a live Adobe app: schemas, input checks, the
// overwrite guard, unsupported formats, file naming and the prompt text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { allToolSchemas, toolSchemas, validateToolInput, executeTool } from "../harness/tools.mjs";
import { uniquePath, safeBase, outputFolder } from "../bridges/files.mjs";
import { buildSystem } from "../harness/system.mjs";
import { doneLabel } from "../labels.mjs";
import * as illustrator from "../bridges/illustrator.mjs";
import * as photoshop from "../bridges/photoshop.mjs";
import * as aftereffects from "../bridges/aftereffects.mjs";

function fakeBridge(over = {}) {
  const calls = [];
  return {
    calls,
    label: "Illustrator",
    capabilities: { inspect: true, edit: true, render: true, export: ["png", "pdf"], save: ["copy", "overwrite"], preflight: true },
    async exportCopy(a) { calls.push(["export", a]); return { path: "/x/a.pdf", format: a.format, note: "n", warnings: ["RGB"], documentUnchanged: true }; },
    async saveDocument(a) { calls.push(["save", a]); return { path: "/x/a.ai", mode: a.mode || "copy", note: "n", warnings: [] }; },
    async preflight() { calls.push(["preflight"]); return { document: "a.ai", info: {}, warnings: [] }; },
    ...over,
  };
}

test("tool list: fixed for the API engine, trimmed per app for MCP", () => {
  const names = allToolSchemas().map((t) => t.name);
  assert.deepEqual(names, ["inspect", "edit", "undo", "render", "export", "save", "preflight"]);
  assert.deepEqual(toolSchemas(illustrator).map((t) => t.name), ["inspect", "edit", "undo", "render", "export", "save", "preflight"]);
  assert.ok(!toolSchemas(photoshop).some((t) => t.name === "preflight"));
  assert.ok(toolSchemas(aftereffects).some((t) => t.name === "save"));
  const exp = allToolSchemas().find((t) => t.name === "export");
  assert.match(exp.description, /Illustrator png, jpg, svg, pdf/);
  assert.match(exp.description, /Never overwrites/);
});

test("bridge capabilities say what each app can do", () => {
  assert.deepEqual(illustrator.capabilities.export, ["png", "jpg", "svg", "pdf"]);
  assert.deepEqual(photoshop.capabilities.save, ["copy", "overwrite"]);
  assert.deepEqual(aftereffects.capabilities.save, ["overwrite"]);
});

test("input validation: enums, booleans, numbers", () => {
  assert.equal(validateToolInput("export", { format: "pdf", bleedMm: 3, cropMarks: true }), null);
  assert.match(validateToolInput("export", { format: "tiff" }), /must be one of/);
  assert.match(validateToolInput("export", { format: "pdf", bleedMm: "3" }), /number/);
  assert.match(validateToolInput("export", { format: "pdf", cropMarks: "yes" }), /true or false/);
  assert.match(validateToolInput("save", {}), /missing "mode"/);
  assert.match(validateToolInput("export", {}), /missing "format"/);
});

test("save: overwrite saves the file itself, no extra confirmation round", async () => {
  const b = fakeBridge();
  const r = await executeTool(b, "save", { mode: "overwrite" });
  assert.equal(r.is_error, false);
  assert.match(r.content, /"mode": "overwrite"/);
  assert.equal(b.calls[0][1].mode, "overwrite");
});

test("save: copy works; unsupported mode is explained", async () => {
  const b = fakeBridge();
  const r = await executeTool(b, "save", { mode: "copy" });
  assert.equal(r.is_error, false);
  assert.equal(b.calls[0][1].mode, "copy");
  const ae = fakeBridge({ label: "After Effects", capabilities: { save: ["overwrite"] } });
  const r2 = await executeTool(ae, "save", { mode: "copy" });
  assert.equal(r2.is_error, true);
  assert.match(r2.content, /After Effects supports overwrite/);
  assert.equal(ae.calls.length, 0);
});

test("export: unsupported format is refused before touching the app", async () => {
  const b = fakeBridge({ label: "Photoshop", capabilities: { export: ["png", "jpg"] } });
  const r = await executeTool(b, "export", { format: "pdf" });
  assert.equal(r.is_error, true);
  assert.match(r.content, /can export png, jpg, not pdf/);
  assert.equal(b.calls.length, 0);
});

test("export: structured result with path and warnings", async () => {
  const r = await executeTool(fakeBridge(), "export", { format: "pdf" });
  assert.equal(r.is_error, false);
  const data = JSON.parse(r.content.replace(/^export result: /, ""));
  assert.equal(data.ok, true);
  assert.equal(data.path, "/x/a.pdf");
  assert.deepEqual(data.warnings, ["RGB"]);
});

test("export failure tells the model to be honest and give manual steps", async () => {
  const b = fakeBridge({ async exportCopy() { throw new Error("boom"); } });
  const r = await executeTool(b, "export", { format: "pdf" });
  assert.equal(r.is_error, true);
  assert.match(r.content, /Nothing was written.*manual steps/);
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
});

test("output folder must be inside the home folder", () => {
  assert.throws(() => outputFolder("/etc"), /inside your home folder/);
  assert.throws(() => outputFolder("~/../../etc"), /inside your home folder/);
  assert.ok(outputFolder().startsWith(homedir()));
});

test("system prompt carries the behaviour rules", () => {
  const s = buildSystem();
  for (const phrase of [/Don't refuse flatly/, /Act, don't ask/, /The selection is context, not a limit/, /Never promise something/, /what you did, anything you didn't do/, /never call save\(\), saveAs\(\) or close\(\)/]) {
    assert.match(s, phrase);
  }
});

test("labels for the new tools", () => {
  assert.equal(doneLabel("mcp__komposit__save", { mode: "copy" }), "Saved a copy");
  assert.equal(doneLabel("save", { mode: "overwrite" }), "Saved the document");
  assert.equal(doneLabel("preflight"), "Checked print readiness");
});

import { selectionNote, selectionBlock } from "../harness/context.mjs";

test("selection: Illustrator text range, nested items, partial paths", () => {
  const text = { doc: "a.ai", activeArtboard: "Front", kind: "text", text: "Anaerobic", length: 9, frameText: "Natural Anaerobic", frameRef: "doc.layers[0].pageItems[2]", font: "Didot", size: 24 };
  assert.match(illustrator.summarizeSelection(text), /Editing text: "Anaerobic" is selected \(9 characters\) inside the text frame "Natural Anaerobic", Didot 24pt\. Change only this range/);
  assert.equal(selectionNote("illustrator", { data: text }), 'Selected text: "Anaerobic"');
  const items = { doc: "a.ai", activeArtboard: "Front", kind: "items", count: 3, artboards: ["Front", "Back"], items: [
    { ref: "doc.layers[0].pageItems[0].pageItems[1]", type: "PathItem", name: "Photo", bounds: [0, 0, 10, -10], w: 10, h: 10, layer: "Art", artboard: "Front", inGroup: "Badge", insideClippingMask: true },
    { ref: "doc.layers[0].pageItems[1]", type: "PathItem", name: "", bounds: [0, 0, 10, -10], w: 10, h: 10, layer: "Art", artboard: "Back", selectedPoints: "2 of 10" },
  ] };
  const s = illustrator.summarizeSelection(items);
  assert.match(s, /3 items selected across artboards "Front", "Back"/);
  assert.match(s, /inside group "Badge" \(a clipping mask\)/);
  assert.match(s, /only 2 of 10 points selected/);
  assert.match(s, /…and 1 more/);
  assert.equal(selectionNote("illustrator", { data: items }), 'Selected: 3 items ("Photo", "path", …)');
  assert.equal(selectionNote("illustrator", { data: { kind: "nothing", doc: "a" } }), null, "no step line when nothing is selected");
});

test("selection: Photoshop layers and marquee; After Effects keys", () => {
  const ps = { doc: "p.psd", width: 800, height: 600, count: 2, marquee: [1, 2, 3, 4], layers: [
    { ref: "0", name: "Headline", type: "layer", kind: "TEXT", visible: true, text: "Spring", font: "Didot", size: 40, bounds: [1, 2, 3, 4] },
    { ref: "1/1", name: "Photo", type: "layer", kind: "NORMAL", visible: true, inGroup: "Hero", mask: true, bounds: [0, 0, 0, 0] },
  ] };
  const s = photoshop.summarizeSelection(ps);
  assert.match(s, /2 layers selected/);
  assert.match(s, /pixel layer "Photo", in group "Hero", has a layer mask, empty/);
  assert.match(s, /marquee selection covers \[1, 2, 3, 4\]px/);
  assert.equal(selectionNote("photoshop", { data: ps }), 'Selected: 2 layers ("Headline", "Photo"), inside a marquee');
  const ae = { kind: "comp", comp: { name: "Main", w: 1920, h: 1080, duration: 10, fps: 30, time: 2.5, workArea: [0, 5] }, layers: [], props: [
    { layer: "Title", path: "Transform > Position", ref: 'comp.layer(1).property("ADBE Transform Group").property("ADBE Position")', keys: 3, selectedKeys: 2, selectedKeyTimes: [0.5, 1.2] },
  ] };
  const a = aftereffects.summarizeSelection(ae);
  assert.match(a, /playhead at 2.5s; work area 0–5s/);
  assert.match(a, /"Title" > Transform > Position, 3 keyframes, 2 selected at 0.5s, 1.2s/);
  assert.equal(selectionNote("aftereffects", { data: ae }), 'Selected: Position on "Title"');
  assert.match(selectionBlock("illustrator", { summary: "X" }), /^\[Live selection in Illustrator when this message was sent\]\nX\n\n$/);
  assert.equal(selectionBlock("illustrator", null), "");
});

import { newDialogs, dialogText } from "../dialogwatch.mjs";

test("dialog watch: only new, dialog-sized windows count", () => {
  const base = new Map([[1, { w: 1440, h: 875 }], [2, { w: 1200, h: 828 }]]);
  const now = new Map([[1, { w: 1440, h: 875 }], [2, { w: 1200, h: 828 }], [7, { w: 480, h: 220 }], [8, { w: 40, h: 20 }]]);
  assert.deepEqual(newDialogs(base, now), [7]);
  assert.match(dialogText("illustrator"), /^Illustrator seems to be showing a dialog/);
});

test("render: After Effects frame strips and preview video reach the model and the chat", async () => {
  const im = (d) => ({ media_type: "image/png", data: d });
  const b = { label: "After Effects", capabilities: { render: true }, async render(input) { return { image: im("B"), images: [im("A"), im("B"), im("C")], note: "3 frames", video: input.video ? "/tmp/komposit/ae_preview_1.mp4" : null }; } };
  const r = await executeTool(b, "render", { frames: 3, video: true });
  assert.equal(r.content.filter((c) => c.type === "image").length, 3, "the model sees every frame");
  assert.match(r.content[0].text, /Preview video: \/tmp\/komposit\/ae_preview_1\.mp4/);
  assert.equal(r.meta.video, "/tmp/komposit/ae_preview_1.mp4");
  assert.equal(r.meta.image.data, "B", "the step thumbnail is the middle frame");
  assert.match(validateToolInput("export", { format: "mp4" }) || "", /^$/);
  assert.deepEqual(aftereffects.capabilities.export, ["png", "mp4"]);
  assert.equal(doneLabel("render", { video: true }), "Rendered a preview video");
});

import { filesBlock } from "../harness/attachments.mjs";
import * as chatStore from "../chats.mjs";

test("attachments: saved with the chat, safe unique names, listed with paths, text inlined", () => {
  const chat = chatStore.createChat({ app: "illustrator", title: "attach unit test" });
  try {
    const b64 = (s) => Buffer.from(s).toString("base64");
    const a = chatStore.saveFile(chat.id, { name: "../../evil/copy.txt", data: b64("Headline: Spring sale") });
    const b = chatStore.saveFile(chat.id, { name: "copy.txt", data: b64("second") });
    const pdf = chatStore.saveFile(chat.id, { name: "Brief v2.pdf", data: b64("%PDF-1.4") });
    assert.equal(a.name, "copy.txt", "path parts are dropped");
    assert.equal(b.name, "copy 2.txt", "never overwrites");
    assert.ok(a.path.startsWith(chatStore.filesDir(chat.id)));
    const block = filesBlock([{ ...a, media_type: "text/plain" }, { ...pdf, media_type: "application/pdf" }]);
    assert.match(block, /^\[Attached files, saved on this (Mac|computer)/);
    assert.match(block, /- copy\.txt \(text, 1 KB\): .*copy\.txt/);
    assert.match(block, /- Brief v2\.pdf \(PDF, 1 KB\): /);
    assert.match(block, /--- copy\.txt ---\nHeadline: Spring sale\n--- end of copy\.txt ---/);
    assert.equal(filesBlock([]), "");
  } finally {
    chatStore.deleteChat(chat.id);
  }
});
