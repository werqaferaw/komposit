// API engine tests, no network and no API key: a local mock speaks the
// Anthropic streaming wire format to the real SDK-based provider, and the
// harness loop runs against a fake bridge (or the real one with KOMPOSIT_LIVE=1).
//
//   node companion/test/api-engine.test.mjs
//   KOMPOSIT_LIVE=1 node companion/test/api-engine.test.mjs   # also inspects the open Photoshop doc
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { anthropic } from "../providers/anthropic.mjs";
import { runTurn } from "../harness/loop.mjs";
import { allToolSchemas, executeTool } from "../harness/tools.mjs";

// ---------- a mock Anthropic API ----------

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_mock" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

function message(content, stop_reason) {
  const ev = [{ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }];
  content.forEach((b, index) => {
    if (b.type === "thinking") {
      ev.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      if (b.thinking) ev.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking } });
      ev.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature } });
    } else if (b.type === "text") {
      ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else if (b.type === "tool_use") {
      ev.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      // eager streaming: input arrives in fragments
      for (let i = 0; i < json.length; i += 7) ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(i, i + 7) } });
    }
    ev.push({ type: "content_block_stop", index });
  });
  ev.push({ type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 42 } });
  ev.push({ type: "message_stop" });
  return ev;
}

async function mockServer(script) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body || "{}");
      seen.push({ headers: req.headers, body: j, path: req.url });
      const step = script[Math.min(seen.length - 1, script.length - 1)];
      if (step.status) {
        res.writeHead(step.status, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: step.errType || "api_error", message: step.message || "x" } }));
      }
      sse(res, message(step.content, step.stop));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, seen, close: () => new Promise((r) => server.close(r)) };
}

// A fake bridge that answers like the real one.
const fakeBridge = {
  capabilities: { inspect: true, edit: true, render: true, export: ["png"] },
  async inspect() { return { text: JSON.stringify({ layers: ["Title", "Background"] }), image: { media_type: "image/png", data: "iVBORw0KGgo=" } }; },
  async edit(code) { return { ok: true, result: code.length, logs: [] }; },
  async render() { return { image: { media_type: "image/png", data: "iVBORw0KGgo=" }, note: "canvas" }; },
  async exportCopy() { return { path: "/tmp/x.png" }; },
  async undo() { return { ok: true }; },
};

// ---------- provider: the request we send, and parsing ----------

test("anthropic provider: request shape (Opus 5.5, betas, fallbacks, effort, caching, eager tools)", async () => {
  const m = await mockServer([{ content: [{ type: "thinking", thinking: "Checking the layers first.", signature: "sig_A" }, { type: "tool_use", id: "tu_1", name: "edit", input: { code: "var x = 1;", explanation: "Set x" } }], stop: "tool_use" }]);
  const events = [];
  const r = await anthropic.stream({
    system: "SYSTEM", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: allToolSchemas(),
    effort: "low", creds: { apiKey: "sk-test", baseUrl: m.base }, onEvent: (e) => events.push(e),
  });
  const { headers, body, path } = m.seen[0];
  assert.equal(path.startsWith("/v1/messages"), true);
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.max_tokens, 64000);
  assert.equal(body.stream, true);
  assert.deepEqual(body.thinking, { type: "adaptive", display: "updates" });
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.equal(body.fallbacks, "default");
  assert.deepEqual(body.cache_control, { type: "ephemeral" });
  assert.deepEqual(body.system, [{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }]);
  assert.ok(body.tools.every((t) => t.eager_input_streaming === true), "eager input streaming on every tool");
  assert.ok(!("tool_choice" in body), "no forced tool choice (400 on Opus 5.5)");
  assert.ok(!("temperature" in body) && !("top_p" in body), "no sampling params (removed in 2026-10-21)");
  const betas = String(headers["anthropic-beta"]);
  assert.ok(betas.includes("thinking-display-updates-2026-08-18") && betas.includes("server-side-fallback-2026-07-01"), betas);
  assert.equal(headers["authorization"], "Bearer sk-test", "SDK 1.x sends the key as a bearer token");
  // parsing
  assert.equal(r.stopReason, "tool_use");
  assert.deepEqual(r.content[0], { type: "thinking", thinking: "Checking the layers first.", signature: "sig_A" });
  assert.equal(r.content[1].type, "tool_use");
  assert.deepEqual(r.content[1].input, { code: "var x = 1;", explanation: "Set x" });
  assert.ok(events.some((e) => e.type === "thinking" && e.delta.includes("Checking")));
  await m.close();
});

test("anthropic provider: errors come back as plain sentences", async () => {
  const m = await mockServer([{ status: 401, errType: "authentication_error", message: "Invalid invite code" }]);
  await assert.rejects(
    anthropic.stream({ system: "S", messages: [{ role: "user", content: "x" }], tools: [], creds: { apiKey: "bad", baseUrl: m.base } }),
    (e) => anthropic.explainError(e).code === "auth",
  );
  await m.close();
});

// ---------- harness: append-only history across turns ----------

test("loop: history is append-only and the prompt prefix never changes (two turns, app switch)", async () => {
  const m = await mockServer([
    { content: [{ type: "thinking", thinking: "I'll look at the document.", signature: "s1" }, { type: "tool_use", id: "t1", name: "inspect", input: {} }], stop: "tool_use" },
    { content: [{ type: "thinking", thinking: "", signature: "s2" }, { type: "text", text: "It has two layers." }], stop: "end_turn" },
    { content: [{ type: "tool_use", id: "t2", name: "render", input: {} }], stop: "tool_use" },
    { content: [{ type: "text", text: "Rendered." }], stop: "end_turn" },
  ]);
  const creds = { apiKey: "k", baseUrl: m.base };
  const events = [];
  let saved = null;
  const h1 = await runTurn({ app: "photoshop", history: [], userText: "What's in it?", provider: anthropic, creds, bridge: fakeBridge, emit: (e) => events.push(e), save: (msgs) => (saved = structuredClone(msgs)) });
  const h2 = await runTurn({ app: "illustrator", history: structuredClone(saved), userText: "Render it", provider: anthropic, creds, bridge: fakeBridge, emit: (e) => events.push(e), save: (msgs) => (saved = structuredClone(msgs)) });

  const reqs = m.seen.map((s) => s.body);
  assert.equal(reqs.length, 4);
  for (let i = 1; i < reqs.length; i++) {
    assert.deepEqual(reqs[i].system, reqs[0].system, "system prompt identical in every request");
    assert.deepEqual(reqs[i].tools, reqs[0].tools, "tool list identical in every request");
    const prev = reqs[i - 1].messages;
    assert.deepEqual(reqs[i].messages.slice(0, prev.length), prev, `request ${i} starts with request ${i - 1}'s messages, unchanged`);
  }
  // thinking blocks went back exactly as received
  const asst = reqs[1].messages[1];
  assert.deepEqual(asst.content[0], { type: "thinking", thinking: "I'll look at the document.", signature: "s1" });
  // each user message names its app
  assert.match(reqs[0].messages[0].content.at(-1).text, /^\[App: Photoshop\]/);
  assert.match(reqs[2].messages.at(-1).content.at(-1).text, /^\[App: Illustrator\]/);
  // events: the progress note, the tool step, the final answers
  assert.ok(events.some((e) => e.type === "note" && e.text === "I'll look at the document."));
  assert.ok(events.some((e) => e.type === "tool_done" && e.name === "inspect" && !e.is_error));
  assert.deepEqual(events.filter((e) => e.type === "final").map((e) => e.text), ["It has two layers.", "Rendered."]);
  assert.deepEqual(saved, h2);
  assert.equal(h1.length, 4);
  await m.close();
});

test("loop: a refusal adds nothing, and the next message continues cleanly", async () => {
  const m = await mockServer([
    { content: [], stop: "refusal" },
    { content: [{ type: "text", text: "Done." }], stop: "end_turn" },
  ]);
  const creds = { apiKey: "k", baseUrl: m.base };
  const events = [];
  let saved = [];
  await runTurn({ app: "photoshop", history: [], userText: "first", provider: anthropic, creds, bridge: fakeBridge, emit: (e) => events.push(e), save: (x) => (saved = structuredClone(x)) });
  assert.ok(events.some((e) => e.type === "refusal"));
  assert.equal(saved.length, 1, "only the user message is stored");
  await runTurn({ app: "photoshop", history: saved, userText: "second", provider: anthropic, creds, bridge: fakeBridge, emit: () => {}, save: (x) => (saved = structuredClone(x)) });
  const sent = m.seen[1].body.messages;
  assert.equal(sent.length, 1, "the new text joins the unanswered user message (roles stay alternating)");
  assert.equal(sent[0].content.length, 2);
  await m.close();
});

test("loop: incomplete tool input is refused, not run", async () => {
  const m = await mockServer([
    { content: [{ type: "tool_use", id: "t1", name: "edit", input: { explanation: "no code" } }], stop: "tool_use" },
    { content: [{ type: "text", text: "Fixed." }], stop: "end_turn" },
  ]);
  let ran = false;
  const bridge = { ...fakeBridge, async edit() { ran = true; return { ok: true }; } };
  await runTurn({ app: "photoshop", history: [], userText: "go", provider: anthropic, creds: { apiKey: "k", baseUrl: m.base }, bridge, emit: () => {}, save: () => {} });
  assert.equal(ran, false);
  const result = m.seen[1].body.messages[2].content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /INVALID_INPUT: missing "code"/);
  await m.close();
});

test("live (optional): inspect the open Photoshop document through the real bridge", { skip: process.env.KOMPOSIT_LIVE !== "1" }, async () => {
  const { getBridge } = await import("../bridges/index.mjs");
  const r = await executeTool(getBridge("photoshop"), "inspect", {});
  assert.equal(r.is_error, false);
  assert.ok(Array.isArray(r.content) && r.content[0].text.length > 20);
});
