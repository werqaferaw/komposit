// The standalone MCP server, spoken to over stdio exactly as an AI app would. The
// connectors are stand-ins (mcp/testing/fake-connectors.ts): no real app is ever reached.
// HOME points at a temporary folder, so exports land there.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startClient, textOf } from "./testing/client.ts";
import type { TestClient } from "./testing/client.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "server.ts");
const FAKES = join(HERE, "testing", "fake-connectors.ts");

let home = "";
let logFile = "";

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home, KOMPOSIT_MCP_TEST_CONNECTORS: FAKES, KOMPOSIT_MCP_TEST_LOG: logFile, ...extra };
  delete e.KOMPOSIT_ALLOW_RISKY_SCRIPTS;
  delete e.KOMPOSIT_EXPORT_DIR;
  return { ...e, ...extra };
}

function ops(): { app: string; op: string; start: number; end: number; [k: string]: unknown }[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function connect(extra: Record<string, string> = {}): Promise<TestClient> {
  const c = startClient(process.execPath, [SERVER], env(extra));
  const init = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.ok(init.result, c.stderr());
  c.notify("notifications/initialized");
  return c;
}

before(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "kmcp-")));
  logFile = join(home, "calls.jsonl");
});
after(() => rmSync(home, { recursive: true, force: true }));

test("initialize, ping, unknown methods and bad lines", async () => {
  const c = startClient(process.execPath, [SERVER], env());
  try {
    const init = await c.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.result.protocolVersion, "2025-03-26");
    assert.equal(init.result.serverInfo.name, "komposit-mcp");
    assert.ok(init.result.capabilities.tools);
    assert.match(init.result.instructions, /Look first/);
    assert.match(init.result.instructions, /Never save unless the person asks/);
    assert.match(init.result.instructions, /guide/);
    const odd = await c.request("initialize", { protocolVersion: "1999-01-01" });
    assert.equal(odd.result.protocolVersion, "2025-06-18");
    c.notify("notifications/initialized"); // no answer expected
    assert.deepEqual((await c.request("ping")).result, {});
    const unknown = await c.request("sampling/whatever");
    assert.equal(unknown.error.code, -32601);
    assert.ok(!/\bat \w+ \(/.test(unknown.error.message), "no stack traces");
    const bad = await c.raw("{not json");
    assert.equal(bad.error.code, -32700);
    assert.deepEqual((await c.request("resources/list")).result, { resources: [] });
  } finally {
    assert.equal(await c.close(), 0);
  }
});

test("tools/list: the standalone tools, in order, app required, refuse wording", async () => {
  const c = await connect();
  try {
    const { tools } = (await c.request("tools/list")).result;
    assert.deepEqual(tools.map((t: any) => t.name), ["apps", "documents", "inspect", "edit", "render", "export", "save", "undo", "preflight", "place", "open", "new_document", "guide"]);
    for (const t of tools) {
      assert.equal(typeof t.description, "string");
      assert.equal(t.inputSchema.type, "object");
      if (!["apps", "documents"].includes(t.name)) assert.ok(t.inputSchema.required.includes("app"), t.name);
    }
    const edit = tools.find((t: any) => t.name === "edit");
    assert.match(edit.description, /refused with a plain explanation/);
    assert.equal(tools.find((t: any) => t.name === "inspect").annotations.readOnlyHint, true);
    assert.ok(!tools.find((t: any) => t.name === "guide").inputSchema.properties.doc, "guide takes no doc");
    assert.ok(tools.find((t: any) => t.name === "export").inputSchema.properties.doc);
  } finally {
    await c.close();
  }
});

test("apps and documents; a closed app is never started", async () => {
  const c = await connect();
  try {
    const before = ops().length;
    const apps = await c.call("apps");
    assert.ok(!apps.isError);
    const list = JSON.parse(textOf(apps).replace(/^apps result: /, ""));
    assert.deepEqual(list.map((a: any) => [a.app, a.ready]), [["illustrator", true], ["photoshop", true], ["aftereffects", false]]);
    assert.equal(list[2].reason, "After Effects isn't open.");
    assert.equal(list[0].language, "extendscript");

    const docs = await c.call("documents");
    const d = JSON.parse(textOf(docs).replace(/^documents result: /, ""));
    assert.deepEqual(d.map((x: any) => x.app), ["illustrator", "photoshop"], "only open apps are asked");
    assert.equal(d[0].documents[0].name, "Poster.ai");

    const closed = await c.call("inspect", { app: "aftereffects" });
    assert.equal(closed.isError, true);
    assert.match(textOf(closed), /After Effects isn't open\. Ask the person to open it/);
    assert.ok(!ops().slice(before).some((o) => o.app === "aftereffects"), "nothing reached the closed app");
  } finally {
    await c.close();
  }
});

test("inspect and render return pictures as MCP image content", async () => {
  const c = await connect();
  try {
    const r = await c.call("inspect", { app: "illustrator" });
    assert.ok(!r.isError);
    assert.match(textOf(r), /Document Poster\.ai/);
    assert.match(textOf(r), /Current selection:\nNothing selected\./);
    const img = r.content.find((x) => x.type === "image");
    assert.equal(img.mimeType, "image/png");
    assert.equal(Buffer.from(img.data, "base64")[1], 0x50); // "P" of the PNG signature
    const frames = await c.call("render", { app: "illustrator", frames: 3 });
    assert.equal(frames.content.filter((x) => x.type === "image").length, 3);
    assert.match(textOf(frames), /Rendered the active artboard/);
  } finally {
    await c.close();
  }
});

test("input is checked and app is required with several apps", async () => {
  const c = await connect();
  try {
    const noApp = await c.call("inspect", {});
    assert.equal(noApp.isError, true);
    assert.match(textOf(noApp), /Say which app to act in/);
    const noFormat = await c.call("export", { app: "illustrator" });
    assert.equal(noFormat.isError, true);
    assert.match(textOf(noFormat), /"format" is missing/);
    const badFormat = await c.call("export", { app: "photoshop", format: "svg" });
    assert.match(textOf(badFormat), /Photoshop can export png, pdf, not svg/);
    const nope = await c.call("format_disk", {});
    assert.match(textOf(nope), /no tool called "format_disk"/);
    const noFile = await c.call("place", { app: "photoshop", path: "/no/such/file.png" });
    assert.equal(noFile.isError, true);
    assert.match(textOf(noFile), /there's no file at/);
  } finally {
    await c.close();
  }
});

test("risky scripts and scripts that save are refused, and nothing runs", async () => {
  const c = await connect();
  try {
    const before = ops().length;
    for (const code of ["system.callSystem('rm -rf ~')", "File('~/a.txt').remove()", "app.quit()", "app.activeDocument.close(SaveOptions.DONOTSAVECHANGES)", "app.activeDocument.save()"]) {
      const r = await c.call("edit", { app: "illustrator", code });
      assert.equal(r.isError, true, code);
      assert.match(textOf(r), /edit didn't run, so nothing changed/, code);
      assert.match(textOf(r), /KOMPOSIT_ALLOW_RISKY_SCRIPTS=1/);
    }
    // A save to a path is named once, not twice.
    const saveAs = textOf(await c.call("edit", { app: "illustrator", code: "app.activeDocument.saveAs(new File('~/x.ai'))" }));
    assert.match(saveAs, /this script saves or exports to a file on your computer \(/);
    assert.doesNotMatch(saveAs, /saves the document/);
    assert.equal(ops().slice(before).filter((o) => o.op === "run").length, 0);
    const ok = await c.call("edit", { app: "illustrator", code: "var l = doc.layers[0]; l.remove(); 1" });
    assert.ok(!ok.isError);
    assert.match(textOf(ok), /edit applied \(not saved\)\.\nresult: \{"ran":/);
    const failed = await c.call("edit", { app: "illustrator", code: "THROW" });
    assert.equal(failed.isError, true);
    assert.match(textOf(failed), /edit failed: boom is not defined \(line 1\)/);
  } finally {
    await c.close();
  }
});

test("KOMPOSIT_ALLOW_RISKY_SCRIPTS=1 lets the person allow them", async () => {
  const c = await connect({ KOMPOSIT_ALLOW_RISKY_SCRIPTS: "1" });
  try {
    const r = await c.call("edit", { app: "photoshop", code: "app.activeDocument.save()" });
    assert.ok(!r.isError, textOf(r));
  } finally {
    await c.close();
  }
});

test("exports never overwrite and stay inside the home folder; nothing is saved unless asked", async () => {
  const c = await connect();
  try {
    const before = ops().length;
    const exportsDir = join(home, "Komposit Exports");
    const a = await c.call("export", { app: "illustrator", format: "png", name: "Poster" });
    const b = await c.call("export", { app: "illustrator", format: "png", name: "Poster.png" });
    assert.ok(!a.isError && !b.isError, textOf(a) + textOf(b));
    assert.match(textOf(a), new RegExp(`"path": "${join(exportsDir, "Poster.png").replace(/[.]/g, "\\.")}"`));
    assert.match(textOf(b), /Poster 2\.png/);
    assert.deepEqual(readdirSync(exportsDir).sort(), ["Poster 2.png", "Poster.png"]);
    // Default name: the document's.
    const d = await c.call("export", { app: "photoshop", format: "pdf" });
    assert.match(textOf(d), /Poster\.pdf/);
    // An existing file someone else made is never replaced.
    writeFileSync(join(home, "Mine.png"), "mine");
    const e = await c.call("export", { app: "photoshop", format: "png", name: "Mine", outputDir: "~" });
    assert.match(textOf(e), /Mine 2\.png/);
    assert.equal(readFileSync(join(home, "Mine.png"), "utf8"), "mine");
    const outside = await c.call("export", { app: "photoshop", format: "png", outputDir: "/etc" });
    assert.equal(outside.isError, true);
    assert.match(textOf(outside), /only writes inside your home folder/);

    await c.call("edit", { app: "illustrator", code: "doc.layers[0].name = 'x'" });
    await c.call("undo", { app: "illustrator" });
    assert.ok(!ops().slice(before).some((o) => o.op === "save"), "no save without the save tool");
    const s = await c.call("save", { app: "illustrator", mode: "copy" });
    assert.match(textOf(s), /Poster copy\.ai/);
    const saves = ops().slice(before).filter((o) => o.op === "save");
    assert.deepEqual(saves.map((o) => o.mode), ["copy"]);
  } finally {
    await c.close();
  }
});

test("one call at a time per app; different apps side by side", async () => {
  const c = await connect();
  try {
    const before = ops().length;
    await Promise.all([
      c.call("edit", { app: "illustrator", code: "/*A SLEEP:250*/" }),
      c.call("edit", { app: "illustrator", code: "/*B SLEEP:250*/" }),
      c.call("edit", { app: "photoshop", code: "/*C SLEEP:250*/" }),
    ]);
    const runs = ops().slice(before).filter((o) => o.op === "run");
    const il = runs.filter((o) => o.app === "illustrator").sort((x, y) => x.start - y.start);
    const ps = runs.find((o) => o.app === "photoshop")!;
    assert.equal(il.length, 2);
    assert.ok(il[1]!.start >= il[0]!.end, "the second Illustrator call waited for the first");
    assert.ok(ps.start < il[0]!.end, "Photoshop didn't wait for Illustrator");
  } finally {
    await c.close();
  }
});

test("guide, open, place and new_document", async () => {
  const c = await connect();
  try {
    const idx = await c.call("guide", { app: "illustrator" });
    assert.match(textOf(idx), /Topics:/);
    const g = await c.call("guide", { app: "illustrator", topic: "shapes" });
    assert.match(textOf(g), /rectangle/);
    const file = join(home, "logo.png");
    writeFileSync(file, "png");
    const placed = await c.call("place", { app: "photoshop", path: "~/logo.png" });
    assert.ok(!placed.isError, textOf(placed));
    assert.match(textOf(placed), new RegExp(file.replace(/[.]/g, "\\.")));
    const opened = await c.call("open", { app: "illustrator", path: file });
    assert.match(textOf(opened), /"name": "logo\.png"/);
    const made = await c.call("new_document", { app: "photoshop", width: 800, height: 600, name: "Banner" });
    assert.match(textOf(made), /"name": "Banner"/);
    assert.match(textOf(made), /Nothing is saved yet/);
    const pf = await c.call("preflight", { app: "illustrator" });
    assert.match(textOf(pf), /Ready for print/);
  } finally {
    await c.close();
  }
});

test("a call cancelled while it waits for its app never runs and gets no answer", async () => {
  const c = await connect();
  try {
    const before = ops().length;
    const a = c.start("tools/call", { name: "edit", arguments: { app: "illustrator", code: "/*first SLEEP:300*/" } });
    const b = c.start("tools/call", { name: "edit", arguments: { app: "illustrator", code: "/*second*/" } });
    let bAnswered = false;
    void b.done.then(() => (bAnswered = true));
    await new Promise((r) => setTimeout(r, 50));
    c.notify("notifications/cancelled", { requestId: b.id, reason: "test" });
    assert.ok(!(await a.done).result.isError);
    const third = await c.call("edit", { app: "illustrator", code: "/*third*/" });
    assert.ok(!third.isError);
    const codes = ops().slice(before).filter((o) => o.op === "run").map((o) => o.code);
    assert.deepEqual(codes, ["/*first SLEEP:300*/", "/*third*/"]);
    assert.equal(bAnswered, false);
  } finally {
    await c.close();
  }
});
