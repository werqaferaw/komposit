// Smoke test for the built komposit-helper: spawns it and talks JSON-RPC over stdio.
// Builds it first (helper/mac/build.sh) when out/helper/komposit-helper is missing.
//
// Safe by design: it never sends a script or an event to a running app, never asks
// for a permission (ask/prompt are always false), and presses nothing. The only
// file it touches is a temp file it made itself (trashed, then removed from the Trash).
//
//   node --test helper/mac/smoke.test.ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "..", "out", "helper", "komposit-helper");

interface RpcError { code: number; message: string; data?: { kind?: string; [k: string]: unknown } }
interface Reply { id?: number; method?: string; params?: any; result?: any; error?: RpcError }

class Helper {
  child: ChildProcessWithoutNullStreams;
  pending = new Map<number, (r: Reply) => void>();
  notes: Reply[] = [];
  nextId = 1;
  ready: Promise<number>;
  exited: Promise<number | null>;

  constructor() {
    const t0 = performance.now();
    this.child = spawn(BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
    let markReady: (ms: number) => void = () => {};
    this.ready = new Promise((r) => (markReady = r));
    this.exited = new Promise((r) => this.child.on("exit", (code) => r(code)));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const msg = JSON.parse(line) as Reply;
      if (msg.method) {
        if (msg.method === "ready") markReady(performance.now() - t0);
        this.notes.push(msg);
        return;
      }
      const cb = this.pending.get(msg.id as number);
      if (cb) { this.pending.delete(msg.id as number); cb(msg); }
    });
  }

  raw(line: string) { this.child.stdin.write(line + "\n"); }

  send(method: string, params?: unknown): Promise<Reply> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 30000);
      this.pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
      this.raw(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async call(method: string, params?: unknown): Promise<any> {
    const r = await this.send(method, params);
    if (r.error) throw Object.assign(new Error(r.error.message), { rpc: r.error });
    return r.result;
  }

  close() { this.child.stdin.end(); return this.exited; }
}

let h: Helper;
let startupMs = 0;
const scratch = mkdtempSync(join(tmpdir(), "komposit-helper-test-"));

before(async () => {
  if (!existsSync(BIN)) execFileSync(join(HERE, "build.sh"), { stdio: "inherit" });
  h = new Helper();
  startupMs = await h.ready;
});

after(async () => {
  if (h && h.child.exitCode === null) await h.close();
  rmSync(scratch, { recursive: true, force: true });
});

test("starts and says it's ready", () => {
  console.log(`  startup to ready: ${startupMs.toFixed(1)} ms; binary ${statSync(BIN).size} bytes`);
  // About 10 ms warm. The first run after a fresh build takes a few seconds while
  // macOS checks the newly signed binary, so the bound here is loose.
  assert.ok(startupMs < 10000, "starts in under 10 s");
});

test("ping, with round-trip time", async () => {
  const r = await h.call("ping");
  assert.equal(r.pong, true);
  const n = 200;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await h.call("ping");
  const each = (performance.now() - t0) / n;
  console.log(`  ping round trip: ${(each * 1000).toFixed(0)} us average over ${n}`);
  assert.ok(each < 50);
});

test("version", async () => {
  const v = await h.call("version");
  assert.equal(v.name, "komposit-helper");
  assert.equal(typeof v.version, "string");
  assert.equal(v.protocol, 1);
  assert.ok(["arm64", "x86_64"].includes(v.arch));
});

test("system.thermal", async () => {
  const t = await h.call("system.thermal");
  assert.ok(["nominal", "fair", "serious", "critical"].includes(t.state));
  assert.equal(typeof t.lowPowerMode, "boolean");
});

test("windows.list: all windows, then by pid, with a dialog guess", async () => {
  const all = await h.call("windows.list");
  assert.ok(Array.isArray(all.windows));
  assert.ok(Array.isArray(all.dialogs.modal));
  assert.equal(all.dialogs.new, null);
  for (const w of all.windows.slice(0, 20)) {
    assert.equal(typeof w.id, "number");
    assert.equal(typeof w.pid, "number");
    assert.equal(typeof w.layer, "number");
    assert.equal(typeof w.bounds.w, "number");
  }
  const t0 = performance.now();
  const none = await h.call("windows.list", { pid: 999999, baseline: [] });
  console.log(`  windows.list: ${all.windows.length} windows on this Mac; a filtered list took ${(performance.now() - t0).toFixed(1)} ms`);
  assert.deepEqual(none.windows, []);
  assert.deepEqual(none.dialogs.new, []);
  // Every window already in the baseline: nothing counts as new.
  if (all.windows.length) {
    const pid = all.windows[0].pid;
    const mine = await h.call("windows.list", { pid });
    const again = await h.call("windows.list", { pid, baseline: mine.windows.map((w: any) => w.id) });
    const before = new Set(mine.windows.map((w: any) => w.id));
    for (const id of again.dialogs.new) assert.ok(!before.has(id));
  }
});

test("ax.trusted never prompts and answers yes or no", async () => {
  const r = await h.call("ax.trusted", { prompt: false });
  assert.equal(typeof r.trusted, "boolean");
});

test("ax.dialog for a process that isn't an app says so plainly", async () => {
  const r = await h.send("ax.dialog", { pid: 999999 });
  assert.equal(r.error?.data?.kind, "notRunning");
  assert.ok(!/-\d{3,}/.test(r.error!.message), "no error codes in the message");
});

test("appleEvents.permission for an app that isn't installed: notRunning, no prompt", async () => {
  const r = await h.call("appleEvents.permission", { bundleId: "com.example.none", ask: false });
  assert.equal(r.status, "notRunning");
  assert.equal(r.osStatus, -600);
});

test("appleEvents.runScript for an app that isn't open sends nothing and says so", async () => {
  const r = await h.send("appleEvents.runScript", { bundleId: "com.example.none", code: "1+1", timeoutMs: 2000 });
  assert.equal(r.error?.data?.kind, "notRunning");
  assert.match(r.error!.message, /isn't open/);
});

test("files.trash moves a temp file to the Trash and says where", async () => {
  const f = join(scratch, `komposit-helper-smoke-${process.pid}.txt`);
  writeFileSync(f, "made by the komposit-helper smoke test\n");
  const r = await h.call("files.trash", { paths: [f, join(scratch, "not-there.txt")] });
  assert.equal(r.results.length, 2);
  const [moved, missing] = r.results;
  assert.equal(moved.ok, true, moved.error);
  assert.ok(!existsSync(f));
  assert.equal(typeof moved.trashedTo, "string");
  assert.ok(existsSync(moved.trashedTo));
  rmSync(moved.trashedTo, { force: true }); // our own file: don't leave it in the person's Trash
  assert.equal(missing.ok, false);
  assert.equal(typeof missing.error, "string");
});

test("power.assertion on then off", async () => {
  const on = await h.call("power.assertion", { on: true, reason: "Komposit helper smoke test" });
  assert.equal(on.on, true);
  const again = await h.call("power.assertion", { on: true });
  assert.equal(again.changed, false);
  const off = await h.call("power.assertion", { on: false });
  assert.deepEqual(off, { on: false, changed: true });
});

test("quicklook.thumbnail of a temp text file", async () => {
  const f = join(scratch, "note.txt");
  writeFileSync(f, "Komposit\nhelper smoke test\n".repeat(20));
  const t0 = performance.now();
  const r = await h.send("quicklook.thumbnail", { path: f, size: 128, allowIcon: true, timeoutMs: 15000 });
  console.log(`  quicklook.thumbnail: ${(performance.now() - t0).toFixed(0)} ms (${r.result?.type ?? r.error?.data?.kind})`);
  if (r.error) {
    // Some machines (headless CI) can't draw previews; it must still fail plainly.
    assert.ok(["timeout", "failed"].includes(r.error.data?.kind ?? ""));
    return;
  }
  assert.ok(Buffer.from(r.result.png, "base64").subarray(1, 4).toString() === "PNG");
  assert.ok(r.result.width > 0 && r.result.height > 0);
});

test("unknown methods, bad params and broken lines get plain errors", async () => {
  const r1 = await h.send("no.such.thing");
  assert.equal(r1.error?.code, -32601);
  const r2 = await h.send("files.trash", {});
  assert.equal(r2.error?.code, -32602);
  const r3 = await h.send("appleEvents.runScript", { bundleId: "com.example.none", code: "1", verb: "eval" });
  assert.equal(r3.error?.code, -32602);
  h.raw("this is not json");
  const r4 = await h.call("ping"); // still alive after a broken line
  assert.equal(r4.pong, true);
});

test("requests sent together all get answered", async () => {
  const [p] = await Promise.all([h.call("ping"), h.send("windows.list")]);
  assert.equal(p.pong, true);
});

test("closing stdin ends the helper cleanly", async () => {
  const code = await h.close();
  assert.equal(code, 0);
});

// The rest of the bridge mode (relaying, refusals, a core going away) is in bridge/bridge.test.ts.
test("`komposit-helper bridge` is the AI's bridge: no ready, and without a core a plain sentence", async () => {
  const env = { ...process.env };
  delete env.KOMPOSIT_SOCKET;
  delete env.KOMPOSIT_PASS;
  const child = spawn(BIN, ["bridge"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  createInterface({ input: child.stdout }).on("line", (l) => lines.push(l));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  assert.equal(await exited, 0);
  assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Komposit isn't running." } }]);
});
