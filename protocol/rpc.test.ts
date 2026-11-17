import { test } from "node:test";
import assert from "node:assert/strict";
import { createPeer, memoryTransportPair, RpcFailure, RpcCodes, typed } from "./rpc.ts";
import type { Methods, Notifications } from "./wire.ts";

test("call, result and notifications both ways", async () => {
  const [a, b] = memoryTransportPair();
  const core = createPeer(a, { add: (p: { x: number; y: number }) => p.x + p.y });
  const ui = createPeer(b);
  assert.equal(await ui.call("add", { x: 2, y: 3 }), 5);
  const seen: unknown[] = [];
  ui.on("event", (p) => seen.push(p));
  core.notify("event", { seq: 1 });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, [{ seq: 1 }]);
});

test("errors carry a plain message and a code", async () => {
  const [a, b] = memoryTransportPair();
  createPeer(a, { fail: () => { throw new RpcFailure(RpcCodes.invalidParams, "That chat doesn't exist."); } });
  const ui = createPeer(b);
  await assert.rejects(ui.call("fail"), (e: RpcFailure) => e.code === RpcCodes.invalidParams && e.message === "That chat doesn't exist.");
  await assert.rejects(ui.call("nope"), (e: RpcFailure) => e.code === RpcCodes.methodNotFound);
});

test("timeouts, aborts and dispose reject pending calls", async () => {
  const [a, b] = memoryTransportPair();
  createPeer(a, { slow: () => new Promise((r) => setTimeout(() => r(1), 200)) });
  const ui = createPeer(b);
  await assert.rejects(ui.call("slow", {}, { timeoutMs: 20 }), (e: RpcFailure) => e.code === RpcCodes.timeout);
  const ctl = new AbortController();
  const p = ui.call("slow", {}, { signal: ctl.signal });
  ctl.abort();
  await assert.rejects(p, (e: RpcFailure) => e.code === RpcCodes.cancelled);
  const q = ui.call("slow");
  ui.dispose();
  await assert.rejects(q, (e: RpcFailure) => e.code === RpcCodes.closed);
});

test("typed client compiles against the wire methods", async () => {
  const [a, b] = memoryTransportPair();
  createPeer(a, { hello: () => ({ version: "2.0.0-dev", platform: "mac", features: [] }) });
  const client = typed<Methods, Notifications>(createPeer(b));
  const r = await client.call("hello", { client: "test", version: "x" });
  assert.equal(r.platform, "mac");
});
