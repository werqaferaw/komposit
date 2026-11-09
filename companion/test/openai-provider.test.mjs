// Offline tests for the OpenAI-compatible provider (companion/providers/openai.mjs).
// A mock Chat Completions server (node:http, random localhost port) stands in for
// OpenRouter / OpenAI, so nothing leaves the machine and nothing is spent. The
// few checks that need a real hostname (flavor inference) stub global fetch.
//
//   node companion/test/openai-provider.test.mjs
//
// Exits non-zero if any check fails.
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { openai } from "../providers/openai.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms, msg) => Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(msg)))]);

const watchdog = setTimeout(() => {
  console.log("FAIL  watchdog: the run hung for 30s");
  process.exit(1);
}, 30_000);
watchdog.unref();

// ---------- mock server: one scenario per path prefix, baseUrl = `${origin}/<scenario>/v1` ----------

const received = []; // every request the mock saw: { method, path, headers, body }
let hangClosed = null; // resolves when the client drops the "hang" stream

const chunk = (delta, finish_reason = null) => ({
  id: "chatcmpl-mock",
  object: "chat.completion.chunk",
  created: 1,
  model: "mock-model",
  choices: [{ index: 0, delta, finish_reason }],
});
const toolDelta = (tc) => chunk({ tool_calls: [tc] });
const usageChunk = (usage) => ({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1, choices: [], usage });
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function sse(res) {
  res.on("error", () => {}); // writes after the client hangs up are expected in some scenarios
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
}

const EDIT_ARGS = JSON.stringify({ code: 'app.activeDocument.layers[0].name = "Hi";', explanation: "rename layer" });

const scenarios = {
  // Text, reasoning and usage, plus real-world framing quirks.
  async text(res) {
    sse(res);
    res.write(": OPENROUTER PROCESSING\n\n");
    res.write(frame(chunk({ role: "assistant", content: "" })));
    res.write(frame(chunk({ reasoning: "Thinking it over.", content: null })));
    const split = frame(chunk({ content: "Hel" })); // one JSON line split across two reads
    res.write(split.slice(0, 37));
    await sleep(15);
    res.write(split.slice(37));
    res.write('data:{"choices":[{"index":0,"delta":{"content":"lo, wor"},"finish_reason":null}]}\r\n\r\n'); // no space, CRLF
    const multi = Buffer.from(frame(chunk({ content: "ld ✓" })));
    const cut = multi.indexOf(0x9c); // inside the 3-byte UTF-8 check mark
    res.write(multi.subarray(0, cut));
    await sleep(15);
    res.write(multi.subarray(cut));
    res.write(frame(chunk({}, "stop")));
    res.write(frame(usageChunk({ prompt_tokens: 1200, completion_tokens: 42, total_tokens: 1242, prompt_tokens_details: { cached_tokens: 1000 } })));
    res.write("data: [DONE]\n\n");
    res.end(frame(chunk({ content: " AFTER DONE" }))); // must be ignored
  },

  // Text, then two tool calls whose argument fragments interleave.
  async tool(res) {
    sse(res);
    res.write(frame(chunk({ role: "assistant", content: "Let me " })));
    res.write(frame(chunk({ content: "fix that." })));
    res.write(frame(toolDelta({ index: 0, id: "call_edit", type: "function", function: { name: "edit", arguments: "" } })));
    res.write(frame(toolDelta({ index: 0, function: { arguments: EDIT_ARGS.slice(0, 9) } })));
    res.write(frame(toolDelta({ index: 1, id: "call_render", type: "function", function: { name: "render", arguments: "" } })));
    res.write(frame(toolDelta({ index: 0, function: { arguments: EDIT_ARGS.slice(9, 40) } })));
    await sleep(10);
    res.write(frame(toolDelta({ index: 0, function: { arguments: EDIT_ARGS.slice(40) } })));
    res.write(frame(chunk({}, "tool_calls")));
    res.write(frame(usageChunk({ prompt_tokens: 300, completion_tokens: 60 })));
    res.end("data: [DONE]\n\n");
  },

  // Arguments cut off by the token limit.
  async badjson(res) {
    sse(res);
    res.write(frame(toolDelta({ index: 0, id: "call_x", type: "function", function: { name: "edit", arguments: '{"code": "app.' } })));
    res.write(frame(chunk({}, "length")));
    res.end("data: [DONE]\n\n");
  },

  async length(res) {
    sse(res);
    res.write(frame(chunk({ content: "Cut off mid-" })));
    res.write(frame(chunk({}, "length")));
    res.end("data: [DONE]\n\n");
  },

  // Minimal valid reply; the tests inspect what the provider sent.
  async capture(res) {
    sse(res);
    res.write(frame(chunk({ content: "ok" })));
    res.write(frame(chunk({}, "stop")));
    res.end("data: [DONE]\n\n");
  },

  async unauthorized(res) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Incorrect API key provided: sk-bad.", type: "invalid_request_error", code: "invalid_api_key" } }));
  },

  // OpenRouter reports upstream failures inside an otherwise-200 stream.
  async midstream(res) {
    sse(res);
    res.write(frame(chunk({ content: "Partial " })));
    res.write(frame({ ...chunk({ content: "" }, "error"), error: { code: "server_error", message: "Provider disconnected unexpectedly" } }));
    res.end();
  },

  // A server that ignores stream: true and answers with one JSON completion.
  async nonstream(res) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-x",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Plain JSON.", tool_calls: [{ id: "call_1", type: "function", function: { name: "inspect", arguments: "{}" } }] },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
  },

  // OpenRouter-style reasoning: `reasoning` text plus reasoning_details fragments, then a tool call.
  async reasoning(res) {
    sse(res);
    const rd = (frags, extra = {}) => frame(chunk({ reasoning_details: frags, ...extra }));
    res.write(rd([{ type: "reasoning.text", text: "Let me ", signature: null, id: "rs_1", format: "anthropic-claude-v1", index: 0 }], { role: "assistant", content: "", reasoning: "Let me " }));
    res.write(rd([{ type: "reasoning.text", text: "think.", index: 0 }], { reasoning: "think." }));
    res.write(rd([{ type: "reasoning.text", text: "", signature: "sig-old", index: 0 }]));
    res.write(rd([{ type: "reasoning.encrypted", data: "ENC-", id: "rs_2", format: "anthropic-claude-v1", index: 1 }]));
    res.write(rd([{ type: "reasoning.text", text: "", signature: "sig-A", index: 0 }])); // last non-empty signature wins
    res.write(rd([{ type: "reasoning.encrypted", data: "PART2", id: null, index: 1 }])); // null id must not overwrite
    res.write(rd([{ type: "reasoning.summary", summary: "Plan: ", format: "openai-responses-v1", index: 0 }])); // same index, other type
    res.write(rd([{ type: "reasoning.summary", summary: "rename.", format: "", index: 0 }])); // empty format must not overwrite
    res.write(rd([{ type: "reasoning.summary", summary: "loose one" }, { type: "reasoning.summary", summary: "loose two" }])); // no index
    res.write(frame(chunk({ content: "Renaming." })));
    res.write(frame(toolDelta({ index: 0, id: "call_r1", type: "function", function: { name: "edit", arguments: '{"code":"x()"}' } })));
    res.write(frame(chunk({}, "tool_calls")));
    res.end("data: [DONE]\n\n");
  },

  // Rejects (400) any request that carries reasoning_details; otherwise answers.
  async strict(res, rec) {
    if (rec.body.messages.some((m) => "reasoning_details" in m)) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "messages.2.content.0: Invalid signature in thinking block", code: 400 } }));
    }
    return scenarios.capture(res);
  },

  async bad400(res) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "This model's maximum context length is exceeded.", code: 400 } }));
  },

  async err500(res) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Upstream exploded.", code: 500 } }));
  },

  // One chunk, then silence: only an abort ends it.
  async hang(res) {
    hangClosed = new Promise((r) => res.on("close", r));
    sse(res);
    res.write(frame(chunk({ content: "partial" })));
  },
};

const server = createServer(async (req, res) => {
  const parts = [];
  for await (const c of req) parts.push(c);
  let body = null;
  try {
    body = JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {}
  const rec = { method: req.method, path: req.url, headers: req.headers, body };
  received.push(rec);
  const handler = scenarios[req.url.split("/")[1]];
  if (!handler || req.method !== "POST" || !req.url.endsWith("/v1/chat/completions")) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end(`mock: no route for ${req.method} ${req.url}`);
  }
  await handler(res, rec).catch((e) => res.destroy(e));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const base = (name) => `${origin}/${name}/v1`;

// Call the provider against a scenario. Returns the result plus the events it
// emitted and the request the mock received.
function call(name, opts = {}) {
  const events = [];
  return openai
    .stream({
      system: "You are a test.",
      messages: [{ role: "user", content: "Say hello." }],
      tools: [],
      model: "mock-model",
      creds: { apiKey: "sk-test", baseUrl: base(name), flavor: "generic" },
      onEvent: (e) => events.push(e),
      ...opts,
    })
    .then((r) => ({ ...r, events, req: received.at(-1) }));
}

// Swap global fetch for a stub (no network at all) for the duration of fn.
async function withStubbedFetch(respond, fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return respond();
  };
  try {
    await fn(seen);
  } finally {
    globalThis.fetch = real;
  }
}

// A Response whose body arrives `size` bytes at a time.
function bytesResponse(text, size) {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  const body = new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const TOOLS = [
  { name: "inspect", description: "Inspect the document.", input_schema: { type: "object", properties: {}, required: [] } },
  {
    name: "edit",
    description: "Run ExtendScript.",
    input_schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
    eager_input_streaming: true,
    cache_control: { type: "ephemeral" },
  },
];

// ---------- runner ----------

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`ok    ${name}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${name}\n      ${String(e?.stack || e).split("\n").join("\n      ")}`);
  }
}

// ---------- tests ----------

await test("1. streams text + reasoning, maps usage, stops at [DONE]", async () => {
  const r = await call("text", { effort: "high", creds: { apiKey: "sk-test", baseUrl: `${origin}/text/v1/`, flavor: "generic" } });
  assert.equal(r.stopReason, "end_turn");
  assert.deepEqual(r.content, [{ type: "text", text: "Hello, world ✓" }]);
  const texts = r.events.filter((e) => e.type === "text").map((e) => e.delta);
  assert.equal(texts.join(""), "Hello, world ✓");
  assert.deepEqual(r.events.filter((e) => e.type === "thinking").map((e) => e.delta), ["Thinking it over."]);
  // prompt_tokens includes the 1000 cached tokens; Anthropic-shaped input_tokens excludes them.
  assert.deepEqual(r.usage, { input_tokens: 200, output_tokens: 42, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 });
  assert.deepEqual(r.events.at(-1), { type: "done", stopReason: "end_turn" });

  const { req } = r;
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/text/v1/chat/completions"); // trailing slash on baseUrl stripped
  assert.equal(req.headers.authorization, "Bearer sk-test");
  assert.equal(req.headers["content-type"], "application/json");
  assert.equal(req.headers["x-title"], undefined, "attribution headers are OpenRouter-only");
  assert.equal(req.body.model, "mock-model");
  assert.equal(req.body.stream, true);
  assert.deepEqual(req.body.stream_options, { include_usage: true });
  assert.equal(req.body.max_tokens, 16000);
  assert.ok(!("max_completion_tokens" in req.body));
  assert.ok(!("tools" in req.body) && !("tool_choice" in req.body), "no tools -> no tools / tool_choice");
  assert.ok(!("reasoning" in req.body) && !("reasoning_effort" in req.body), "generic flavor sends no effort field");
  assert.deepEqual(req.body.messages, [
    { role: "system", content: "You are a test." },
    { role: "user", content: "Say hello." },
  ]);
});

await test("2. assembles tool calls from argument fragments -> tool_use blocks, stopReason tool_use", async () => {
  const r = await call("tool", { tools: TOOLS });
  assert.equal(r.stopReason, "tool_use");
  assert.deepEqual(r.content, [
    { type: "text", text: "Let me fix that." },
    { type: "tool_use", id: "call_edit", name: "edit", input: JSON.parse(EDIT_ARGS) },
    { type: "tool_use", id: "call_render", name: "render", input: {} },
  ]);
  assert.deepEqual(
    r.events.filter((e) => e.type === "tool_use_start"),
    [
      { type: "tool_use_start", id: "call_edit", name: "edit" },
      { type: "tool_use_start", id: "call_render", name: "render" },
    ],
  );
  assert.deepEqual(r.usage, { input_tokens: 300, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
});

await test("2b. malformed arguments -> { __invalid_json }; finish_reason length -> max_tokens", async () => {
  const bad = await call("badjson", { tools: TOOLS });
  assert.equal(bad.stopReason, "tool_use");
  assert.deepEqual(bad.content, [{ type: "tool_use", id: "call_x", name: "edit", input: { __invalid_json: '{"code": "app.' } }]);
  const cut = await call("length");
  assert.equal(cut.stopReason, "max_tokens");
  assert.deepEqual(cut.content, [{ type: "text", text: "Cut off mid-" }]);
});

await test("3. translates history (user image, tool_use, tool_result + image), tools, openrouter effort", async () => {
  const history = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "UkVG" } },
        { type: "text", text: "Match this reference." },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Plan the edit.", signature: "sig" },
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "Rendering first." },
        { type: "tool_use", id: "toolu_render", name: "render", input: {} },
        { type: "tool_use", id: "toolu_edit", name: "edit", input: { code: "x()", explanation: "try" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_render",
          content: [
            { type: "text", text: "Rendered (artboard)." },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "U0hPVA==" } },
          ],
        },
        { type: "tool_result", tool_use_id: "toolu_edit", content: "edit failed: boom (line 1)", is_error: true },
      ],
    },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_inspect", name: "inspect", input: {} }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_inspect", content: [{ type: "text", text: "state map" }] },
        { type: "text", text: "Also make it bold." },
      ],
    },
  ];
  const snapshot = structuredClone(history);

  const r = await call("capture", {
    system: "SYS",
    messages: history,
    tools: TOOLS,
    model: "anthropic/claude-sonnet-4.5",
    effort: "high",
    creds: { apiKey: "sk-or-test", baseUrl: base("capture"), flavor: "openrouter" },
  });
  const { body, headers } = r.req;

  // The tool messages (ERROR-prefixed when is_error), then one user message with the tools' screenshots.
  assert.deepEqual(body.messages.slice(3, 6), [
    { role: "tool", tool_call_id: "toolu_render", content: "Rendered (artboard)." },
    { role: "tool", tool_call_id: "toolu_edit", content: "ERROR: edit failed: boom (line 1)" },
    {
      role: "user",
      content: [
        { type: "text", text: "Screenshots returned by the tools above:" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,U0hPVA==" } },
      ],
    },
  ]);
  // The whole translation.
  assert.deepEqual(body.messages, [
    { role: "system", content: "SYS" },
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,UkVG" } },
        { type: "text", text: "Match this reference." },
      ],
    },
    {
      role: "assistant",
      content: "Rendering first.",
      tool_calls: [
        { id: "toolu_render", type: "function", function: { name: "render", arguments: "{}" } },
        { id: "toolu_edit", type: "function", function: { name: "edit", arguments: '{"code":"x()","explanation":"try"}' } },
      ],
    },
    { role: "tool", tool_call_id: "toolu_render", content: "Rendered (artboard)." },
    { role: "tool", tool_call_id: "toolu_edit", content: "ERROR: edit failed: boom (line 1)" },
    {
      role: "user",
      content: [
        { type: "text", text: "Screenshots returned by the tools above:" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,U0hPVA==" } },
      ],
    },
    { role: "assistant", content: null, tool_calls: [{ id: "toolu_inspect", type: "function", function: { name: "inspect", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "toolu_inspect", content: "state map" },
    { role: "user", content: "Also make it bold." },
  ]);
  // Tools: Anthropic-only keys (eager_input_streaming, cache_control) dropped.
  assert.deepEqual(body.tools, [
    { type: "function", function: { name: "inspect", description: "Inspect the document.", parameters: TOOLS[0].input_schema } },
    { type: "function", function: { name: "edit", description: "Run ExtendScript.", parameters: TOOLS[1].input_schema } },
  ]);
  assert.equal(body.tool_choice, "auto");
  assert.deepEqual(body.reasoning, { effort: "high" });
  assert.ok(!("reasoning_effort" in body));
  assert.equal(body.max_tokens, 16000);
  assert.equal(headers.authorization, "Bearer sk-or-test");
  assert.equal(headers["http-referer"], "https://komposit.werq.dev");
  assert.equal(headers["x-title"], "Komposit");
  assert.deepEqual(history, snapshot, "the caller's history must not be mutated");
});

await test("3b. openai flavor: max_completion_tokens; reasoning_effort only for o* / gpt-5*", async () => {
  const creds = { apiKey: "sk-test", baseUrl: base("capture"), flavor: "openai" };
  const gpt5 = (await call("capture", { model: "gpt-5-mini", effort: "low", maxTokens: 4096, creds })).req;
  assert.equal(gpt5.body.reasoning_effort, "low");
  assert.equal(gpt5.body.max_completion_tokens, 4096);
  assert.ok(!("max_tokens" in gpt5.body) && !("reasoning" in gpt5.body));
  assert.equal(gpt5.headers["x-title"], undefined);
  const o3 = (await call("capture", { model: "o3", effort: "medium", creds })).req;
  assert.equal(o3.body.reasoning_effort, "medium");
  const gpt41 = (await call("capture", { model: "gpt-4.1", effort: "low", creds })).req;
  assert.ok(!("reasoning_effort" in gpt41.body), "non-reasoning OpenAI model gets no reasoning_effort");
  assert.equal(gpt41.body.max_completion_tokens, 16000);
  const noEffort = (await call("capture", { creds: { ...creds, flavor: "openrouter" } })).req;
  assert.ok(!("reasoning" in noEffort.body), "no effort -> no reasoning field");
});

await test("4. HTTP 401 throws an error with the status and the body", async () => {
  await assert.rejects(call("unauthorized"), (e) => {
    assert.match(e.message, /\b401\b/);
    assert.match(e.message, /Incorrect API key provided/);
    return true;
  });
});

await test("4b. a mid-stream error chunk (OpenRouter style) throws", async () => {
  await assert.rejects(call("midstream"), /Provider disconnected unexpectedly/);
});

await test("5. aborting through signal stops the request", async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  const pending = call("hang", { signal: ac.signal, onEvent: (e) => e.type === "text" && ac.abort() });
  await within(
    assert.rejects(pending, (e) => e.name === "AbortError"),
    3000,
    "the call was still running 3s after abort()",
  );
  assert.ok(Date.now() - t0 < 2000, "abort should end the call promptly");
  await within(hangClosed, 2000, "the mock never saw the connection close");

  const before = received.length; // an already-aborted signal never sends anything
  await assert.rejects(call("capture", { signal: AbortSignal.abort() }), (e) => e.name === "AbortError");
  assert.equal(received.length, before);
});

await test("6. a server that ignores stream: true still works (JSON completion)", async () => {
  const r = await call("nonstream", { tools: TOOLS });
  assert.equal(r.stopReason, "tool_use");
  assert.deepEqual(r.content, [
    { type: "text", text: "Plain JSON." },
    { type: "tool_use", id: "call_1", name: "inspect", input: {} },
  ]);
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
});

await test("7. an unreachable server gives a readable error", async () => {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  await assert.rejects(
    call("capture", { creds: { apiKey: "", baseUrl: `http://127.0.0.1:${deadPort}/v1`, flavor: "generic" } }),
    /Could not reach http:\/\/127\.0\.0\.1:\d+\/v1: .*ECONNREFUSED/,
  );
});

await test("8. flavor inferred from the base URL host (fetch stubbed, no network)", async () => {
  const done = () => new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  await withStubbedFetch(done, async (seen) => {
    const go = (baseUrl, model) =>
      openai.stream({ system: "s", messages: [{ role: "user", content: "hi" }], model, effort: "medium", creds: { apiKey: "k", baseUrl } });
    const r = await go("https://openrouter.ai/api/v1", "openai/gpt-5");
    assert.deepEqual(r, {
      stopReason: "end_turn",
      content: [],
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    });
    await go("https://api.openai.com/v1/", "gpt-5");
    await go("https://api.deepseek.com/v1", "deepseek-chat");
    const [or, oa, gen] = seen;

    assert.equal(or.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(or.headers["HTTP-Referer"], "https://komposit.werq.dev");
    assert.equal(or.headers["X-Title"], "Komposit");
    assert.deepEqual(or.body.reasoning, { effort: "medium" });
    assert.equal(or.body.max_tokens, 16000);

    assert.equal(oa.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(oa.headers["HTTP-Referer"], undefined);
    assert.equal(oa.body.reasoning_effort, "medium");
    assert.equal(oa.body.max_completion_tokens, 16000);

    assert.equal(gen.url, "https://api.deepseek.com/v1/chat/completions");
    assert.equal(gen.headers["HTTP-Referer"], undefined);
    assert.equal(gen.body.max_tokens, 16000);
    assert.ok(!("reasoning" in gen.body) && !("reasoning_effort" in gen.body));
  });
});

await test("9. SSE parsing doesn't depend on how the bytes are split (fetch stubbed)", async () => {
  const body = [
    ": keep-alive",
    "",
    `data: ${JSON.stringify(chunk({ content: "Café ✓ " }))}`,
    "",
    `data:${JSON.stringify(toolDelta({ index: 0, id: "call_1", type: "function", function: { name: "edit", arguments: '{"code":' } }))}`,
    "",
    `data: ${JSON.stringify(toolDelta({ index: 0, function: { arguments: '"x()"}' } }))}`,
    "",
    `data: ${JSON.stringify(chunk({}, "tool_calls"))}`,
    "",
    "data: [DONE]",
    "",
  ].join("\r\n");
  for (const size of [1, 2, 3, 7, 64, 4096]) {
    await withStubbedFetch(
      () => bytesResponse(body, size),
      async () => {
        const r = await openai.stream({ system: "s", messages: [], model: "m", creds: { baseUrl: "http://stub.invalid/v1", flavor: "generic" } });
        assert.deepEqual(
          r.content,
          [
            { type: "text", text: "Café ✓ " },
            { type: "tool_use", id: "call_1", name: "edit", input: { code: "x()" } },
          ],
          `split into ${size}-byte pieces`,
        );
        assert.equal(r.stopReason, "tool_use");
      },
    );
  }
});

// ---------- reasoning_details round trip (OpenRouter) ----------

const OR = (name) => ({ apiKey: "sk-or-test", baseUrl: base(name), flavor: "openrouter" });
const EXPECTED_DETAILS = [
  { type: "reasoning.text", text: "Let me think.", signature: "sig-A", id: "rs_1", format: "anthropic-claude-v1", index: 0 },
  { type: "reasoning.encrypted", data: "ENC-PART2", id: "rs_2", format: "anthropic-claude-v1", index: 1 },
  { type: "reasoning.summary", summary: "Plan: rename.", format: "openai-responses-v1", index: 0 },
  { type: "reasoning.summary", summary: "loose one" },
  { type: "reasoning.summary", summary: "loose two" },
];

// A history as the loop stores it after one tool step: the assistant content
// exactly as the provider returned it (keepsThinking), then the tool result.
async function historyWithReasoning() {
  const first = await call("reasoning", { tools: TOOLS, creds: OR("reasoning") });
  return [
    { role: "user", content: "Rename the layer." },
    { role: "assistant", content: first.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_r1", content: "edit applied." }] },
  ];
}

await test("10. reasoning_details fragments merge; content is [reasoning_details, text, tool_use]", async () => {
  assert.equal(openai.keepsThinking, true);
  assert.ok(!openai.thinkingIsProgress, "raw reasoning is not a progress note");
  const r = await call("reasoning", { tools: TOOLS, effort: "high", creds: OR("reasoning") });
  assert.equal(r.stopReason, "tool_use");
  assert.deepEqual(r.content, [
    { type: "reasoning_details", details: EXPECTED_DETAILS },
    { type: "text", text: "Renaming." },
    { type: "tool_use", id: "call_r1", name: "edit", input: { code: "x()" } },
  ]);
  // thinking deltas come from `reasoning` only, not again from the details
  assert.deepEqual(r.events.filter((e) => e.type === "thinking").map((e) => e.delta), ["Let me ", "think."]);
});

await test("11. the next request returns reasoning_details on that assistant message (openrouter only)", async () => {
  const history = [
    ...(await historyWithReasoning()),
    { role: "assistant", content: [{ type: "text", text: "Renamed it." }] },
    { role: "user", content: "Now make it red." },
  ];
  const snapshot = structuredClone(history);

  const sent = (await call("capture", { messages: history, tools: TOOLS, effort: "medium", creds: OR("capture") })).req.body;
  assert.deepEqual(
    sent.messages.map((m) => m.role),
    ["system", "user", "assistant", "tool", "assistant", "user"],
  );
  assert.deepEqual(sent.messages[2], {
    role: "assistant",
    content: "Renaming.",
    tool_calls: [{ id: "call_r1", type: "function", function: { name: "edit", arguments: '{"code":"x()"}' } }],
    reasoning_details: EXPECTED_DETAILS,
  });
  assert.ok(!("reasoning_details" in sent.messages[4]), "only the message that carried the block gets details");
  assert.ok(!JSON.stringify(sent.messages.map((m) => m.content)).includes("reasoning"), "the block is never sent as content");
  assert.deepEqual(sent.reasoning, { effort: "medium" });

  for (const flavor of ["generic", "openai"]) {
    const creds = { apiKey: "sk-test", baseUrl: base("capture"), flavor };
    const other = (await call("capture", { messages: history, tools: TOOLS, effort: "medium", creds })).req.body;
    assert.ok(!JSON.stringify(other.messages).includes("reasoning"), `${flavor}: no reasoning_details sent`);
    assert.equal(other.messages[2].content, "Renaming.");
  }

  // Effort unset: no `reasoning` param, but the details still go back.
  const noEffort = (await call("capture", { messages: history, tools: TOOLS, creds: OR("capture") })).req.body;
  assert.ok(!("reasoning" in noEffort));
  assert.deepEqual(noEffort.messages[2].reasoning_details, EXPECTED_DETAILS);
  assert.deepEqual(history, snapshot, "the stored history must not be mutated");
});

await test("12. a 400 on a request carrying reasoning_details is retried once without them", async () => {
  const history = await historyWithReasoning();
  const n = received.length;
  const r = await call("strict", { messages: history, tools: TOOLS, effort: "high", creds: OR("strict") });
  assert.equal(received.length - n, 2, "exactly one retry");
  const [rejected, retried] = received.slice(n).map((q) => q.body);
  assert.deepEqual(rejected.messages[2].reasoning_details, EXPECTED_DETAILS);
  assert.ok(retried.messages.every((m) => !("reasoning_details" in m)), "every reasoning_details removed");
  const expected = structuredClone(rejected);
  for (const m of expected.messages) delete m.reasoning_details;
  delete expected.reasoning; // the retry also turns reasoning off (thinking-block requirement)
  assert.ok(!("reasoning" in retried), "reasoning param dropped on the retry");
  assert.deepEqual(retried, expected, "otherwise the very same request");
  assert.equal(r.stopReason, "end_turn");
  assert.deepEqual(r.content, [{ type: "text", text: "ok" }]);
  const warning = r.events.find((e) => e.type === "warning");
  assert.match(warning?.message || "", /reasoning_details rejected \(400\).*Invalid signature/);
});

await test("12b. no retry without reasoning_details or on other statuses; a failed retry throws", async () => {
  const history = await historyWithReasoning();
  const attempt = async (name, creds) => {
    const n = received.length;
    const err = await call(name, { messages: history, creds }).then(() => null, (e) => e);
    return { err: err?.message || "(no error)", count: received.length - n };
  };
  // 400, but the request carried no details (generic never sends them): no retry.
  let a = await attempt("bad400", { apiKey: "sk-test", baseUrl: base("bad400"), flavor: "generic" });
  assert.equal(a.count, 1);
  assert.match(a.err, /\(400\).*maximum context length/);
  // Details sent, but the status isn't 400: no retry.
  a = await attempt("err500", OR("err500"));
  assert.equal(a.count, 1);
  assert.match(a.err, /\(500\)/);
  a = await attempt("unauthorized", OR("unauthorized"));
  assert.equal(a.count, 1);
  assert.match(a.err, /\(401\)/);
  // The retry is rejected too: exactly two attempts, and that second error is thrown.
  a = await attempt("bad400", OR("bad400"));
  assert.equal(a.count, 2);
  assert.match(a.err, /\(400\).*maximum context length/);
});

server.closeAllConnections();
server.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
