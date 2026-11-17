// The bridge on its own, against a stand-in core (a plain socket server written here). Every case
// runs twice: on the Node bridge (bridge.ts: development and Windows) and on the Mac app's native
// one (`komposit-helper bridge`, helper/mac/Sources/Bridge.swift), which must answer alike.
// The bridge with the real toolbox is tested in core/toolbox/server.test.ts.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBridge } from "./build.ts";

// Temp folders this file makes are removed when the test process ends.
const madeDirs: string[] = [];
process.once("exit", () => { for (const d of madeDirs) rmSync(d, { recursive: true, force: true }); });
const keep = (d: string) => (madeDirs.push(d), d);

const here = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(here, "bridge.ts");
const HELPER = join(here, "..", "out", "helper", "komposit-helper");
const tmp = () => keep(realpathSync(mkdtempSync(join(tmpdir(), "kbr-"))));

interface Program { command: string; args: string[] }
const BRIDGES: (Program & { name: string; skip: string | false })[] = [
  { name: "the Node bridge", command: process.execPath, args: [BRIDGE], skip: false },
  {
    name: "the native bridge (komposit-helper bridge)",
    command: HELPER,
    args: ["bridge"],
    skip: process.platform !== "darwin" ? "the native bridge is the Mac app's"
      : !existsSync(HELPER) ? "out/helper/komposit-helper isn't built: run helper/mac/build.sh" : false,
  },
];

/** Each complete line of a decoded stream, in time linear in its length (the pieces are joined
 *  once, when the line ends), so the stand-ins here never slow a long line down themselves. */
function lines(onLine: (line: string) => void) {
  let parts: string[] = [];
  return (chunk: string) => {
    let from = 0;
    let nl;
    while ((nl = chunk.indexOf("\n", from)) !== -1) {
      parts.push(chunk.slice(from, nl));
      const line = parts.join("");
      parts = [];
      from = nl + 1;
      onLine(line);
    }
    if (from < chunk.length) parts.push(chunk.slice(from));
  };
}

function run(p: Program, env: Record<string, string | undefined>) {
  const child = spawn(p.command, p.args, { env: { ...process.env, KOMPOSIT_SOCKET: undefined, KOMPOSIT_PASS: undefined, ...env } as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
  const out: any[] = [];
  const waiters: (() => void)[] = [];
  child.stdout.setEncoding("utf8"); // a character split between two reads stays whole
  child.stdout.on("data", lines((line) => {
    out.push(JSON.parse(line));
    for (const w of waiters.splice(0)) w();
  }));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + "\n");
  const until = async (n: number) => { while (out.length < n) await new Promise<void>((r) => waiters.push(r)); };
  return { child, out, exited, send, until };
}

/** A stand-in core: checks the pass, then answers every request with its method name (and its
 *  params too, with echoParams). `raw` keeps every line after the pass exactly as it came. */
async function fakeCore(opts: { token: string; holdId?: number; echoParams?: boolean; closeOnPass?: boolean }) {
  const dir = tmp();
  // The core serves a named pipe on Windows (core/main.ts toolboxSocketPath), a socket elsewhere.
  const path = process.platform === "win32" ? `\\\\.\\pipe\\${basename(dir)}-c` : join(dir, "c.sock");
  const sockets: Socket[] = [];
  const seen: any[] = [];
  const raw: string[] = [];
  const server = createServer((s) => {
    sockets.push(s);
    let first = true;
    s.setEncoding("utf8");
    s.on("data", lines((line) => {
      if (s.destroyed) return;
      if (first) {
        first = false;
        if (opts.closeOnPass) { s.destroy(); return; }
        const msg = JSON.parse(line);
        if (msg.komposit_pass !== opts.token) { s.end(JSON.stringify({ komposit: "denied", message: "This Komposit run has ended." }) + "\n"); return; }
        s.write(JSON.stringify({ komposit: "ok" }) + "\n");
        return;
      }
      raw.push(line);
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      seen.push(msg);
      if (msg.id !== undefined && msg.id !== opts.holdId) {
        const result = opts.echoParams ? { echo: msg.method, params: msg.params } : { echo: msg.method };
        s.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
      }
    }));
    s.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(path, r));
  return { path, seen, raw, sockets, close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) };
}

for (const bridge of BRIDGES) {
  describe(bridge.name, { skip: bridge.skip }, () => {
    test("no core: every request gets a plain sentence, then the bridge exits", async () => {
      const b = run(bridge, { KOMPOSIT_SOCKET: join(tmp(), "missing.sock"), KOMPOSIT_PASS: "x" });
      b.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await b.until(1);
      assert.deepEqual(b.out[0], { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Komposit isn't running." } });
      assert.equal(await b.exited, 0);
    });

    test("no settings at all: same plain answer", async () => {
      const b = run(bridge, {});
      b.send({ jsonrpc: "2.0", id: "a", method: "tools/list" });
      await b.until(1);
      assert.equal(b.out[0].error.message, "Komposit isn't running.");
      assert.equal(await b.exited, 0);
    });

    test("a refused pass: the core's own sentence reaches the AI", async () => {
      const core = await fakeCore({ token: "good" });
      try {
        const b = run(bridge, { KOMPOSIT_SOCKET: core.path, KOMPOSIT_PASS: "bad" });
        b.send({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} });
        await b.until(1);
        assert.equal(b.out[0].error.message, "This Komposit run has ended.");
        assert.equal(await b.exited, 0);
      } finally {
        await core.close();
      }
    });

    test("a core that closes without answering the pass: Komposit isn't running", async () => {
      const core = await fakeCore({ token: "good", closeOnPass: true });
      try {
        const b = run(bridge, { KOMPOSIT_SOCKET: core.path, KOMPOSIT_PASS: "good" });
        b.send({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} });
        await b.until(1);
        assert.deepEqual(b.out[0], { jsonrpc: "2.0", id: 3, error: { code: -32000, message: "Komposit isn't running." } });
        assert.equal(await b.exited, 0);
      } finally {
        await core.close();
      }
    });

    test("relays both ways, line by line, and exits when stdin closes", async () => {
      const core = await fakeCore({ token: "good" });
      try {
        const b = run(bridge, { KOMPOSIT_SOCKET: core.path, KOMPOSIT_PASS: "good" });
        // Sent before the handshake finishes: queued, then relayed in order.
        b.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
        b.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        b.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        await b.until(2);
        assert.deepEqual(b.out.map((m) => m.result.echo), ["initialize", "tools/list"]);
        assert.deepEqual(core.seen.map((m) => m.method), ["initialize", "notifications/initialized", "tools/list"]);
        b.child.stdin.end();
        assert.equal(await b.exited, 0);
      } finally {
        await core.close();
      }
    });

    test("blank lines are skipped, a \\r before the \\n is dropped, a line that isn't JSON passes as it is", async () => {
      const core = await fakeCore({ token: "good" });
      try {
        const b = run(bridge, { KOMPOSIT_SOCKET: core.path, KOMPOSIT_PASS: "good" });
        b.child.stdin.write(`\n   \r\n\t\n{"jsonrpc":"2.0","id":1,"method":"ping"}\r\nnot json, but passed on\r\n\u00a0\n`);
        await b.until(1);
        b.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        await b.until(2);
        assert.deepEqual(core.raw, [`{"jsonrpc":"2.0","id":1,"method":"ping"}`, "not json, but passed on", `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`]);
        assert.deepEqual(b.out.map((m) => m.id), [1, 2]);
        b.child.stdin.end();
        assert.equal(await b.exited, 0);
      } finally {
        await core.close();
      }
    });

    test("a line of several MB crosses both ways intact, characters of every width included", async () => {
      const core = await fakeCore({ token: "good", echoParams: true });
      try {
        const b = run(bridge, { KOMPOSIT_SOCKET: core.path, KOMPOSIT_PASS: "good" });
        // 1, 2, 3 and 4 bytes in UTF-8, plus what JSON escapes; 17 bytes of JSON each time round,
        // so reads of any power-of-two size end inside every kind of character.
        const content = "ab\u00e9\u20ac\ud83d\ude00\"\\\n".repeat(400_000);
        const t0 = performance.now();
        b.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_file", arguments: { content } } });
        await b.until(1);
        const ms = performance.now() - t0;
        const bytes = Buffer.byteLength(JSON.stringify(b.out[0]));
        console.log(`  ${bridge.name}: ${(bytes / 1e6).toFixed(1)} MB each way in ${ms.toFixed(0)} ms`);
        assert.ok(bytes > 6_000_000, `${bytes} bytes`);
        assert.equal(core.seen[0].params.arguments.content, content);
        assert.equal(b.out[0].result.params.arguments.content, content);
        b.send({ jsonrpc: "2.0", id: 2, method: "ping" }); // still in step after it
        await b.until(2);
        assert.equal(b.out[1].result.echo, "ping");
        b.child.stdin.end();
        assert.equal(await b.exited, 0);
      } finally {
        await core.close();
      }
    });

    test("the core going away answers what's still open, then exits", async () => {
      const core = await fakeCore({ token: "good", holdId: 5 });
      const b = run(bridge, { KOMPOSIT_SOCKET: core.path, KOMPOSIT_PASS: "good" });
      b.send({ jsonrpc: "2.0", id: 4, method: "ping" });
      await b.until(1);
      b.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "render" } });
      while (core.seen.length < 2) await new Promise((r) => setTimeout(r, 10));
      await core.close();
      await b.until(2);
      assert.deepEqual(b.out[1], { jsonrpc: "2.0", id: 5, error: { code: -32000, message: "Komposit stopped before this finished." } });
      assert.equal(await b.exited, 0);
    });
  });
}

test("bundles into one file with esbuild and runs on plain Node", async () => {
  const out = join(tmp(), "komposit-bridge.cjs");
  await buildBridge(out);
  assert.ok(existsSync(out));
  const core = await fakeCore({ token: "good" });
  try {
    const b = run({ command: process.execPath, args: [out] }, { KOMPOSIT_SOCKET: core.path, KOMPOSIT_PASS: "good" });
    b.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await b.until(1);
    assert.equal(b.out[0].result.echo, "initialize");
    b.child.stdin.end();
    assert.equal(await b.exited, 0);
  } finally {
    await core.close();
  }
});
