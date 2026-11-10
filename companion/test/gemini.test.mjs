// Google Gemini through its OpenAI-compatible endpoint (providers/openai.mjs,
// flavor "gemini"): the request shape, thought signatures kept on each tool
// call and sent back on the next request, the skip placeholder for calls that
// never had one, unique call ids, the key check, and chat titles. Offline: a
// local mock streams Chat Completions chunks shaped like Gemini's (the
// signature rides on the tool call as extra_content.google.thought_signature),
// and the real host is only ever reached through a stubbed fetch.
//
//   node --test companion/test/gemini.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openai, GEMINI, GEMINI_SKIP_SIGNATURE, inferFlavor } from "../providers/openai.mjs";
import { runTurn } from "../harness/loop.mjs";
import { checkGeminiKey } from "../setup.mjs";
import { nameChat } from "../titles.mjs";
import { allowSlowReplies } from "../net.mjs";
import { readFileSync } from "node:fs";

const FIX = new URL("./fixtures/gemini/", import.meta.url);
const recorded = (name) => readFileSync(new URL(name, FIX), "utf8");

const SIG_A = "CsEBAXLI2nx1Gm6AsigA"; // opaque base64 in real replies
const SIG_B = "CsEBAXLI2nx1Gm6BsigB";
const TEXT_SIG = "CsEBAXLI2nx1GmTEXT";

const chunk = (delta, finish_reason = null) => ({ id: "gemini-mock", object: "chat.completion.chunk", created: 1, model: "gemini-4-argon", choices: [{ index: 0, delta, finish_reason }] });
const frame = (o) => `data: ${JSON.stringify(o)}\n\n`;

// Each scenario: the chunks of one streamed reply.
const REPLIES = {
  // Step 1: two parallel calls; Gemini signs only the first one.
  step1: [
    chunk({ role: "assistant", content: "" }),
    chunk({
      tool_calls: [
        { index: 0, id: "function-call-1", type: "function", function: { name: "inspect", arguments: "{}" }, extra_content: { google: { thought_signature: SIG_A } } },
        { index: 1, id: "function-call-2", type: "function", function: { name: "render", arguments: "{}" } },
      ],
    }),
    chunk({}, "tool_calls"),
  ],
  // Step 2: a new call that reuses a server id from step 1, signed.
  step2: [
    chunk({ tool_calls: [{ index: 0, id: "function-call-1", type: "function", function: { name: "edit", arguments: JSON.stringify({ code: "app.activeDocument.layers[0].name='Hi';" }) }, extra_content: { google: { thought_signature: SIG_B } } }] }),
    chunk({}, "tool_calls"),
  ],
  // Step 3: the answer, with a signature on the text.
  final: [chunk({ content: "Renamed the first layer to Hi." }), chunk({ content: "", extra_content: { google: { thought_signature: TEXT_SIG } } }, "stop"), { choices: [], usage: { prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 600 } } }],
  models: null, // GET /models, see below
};

const seen = []; // { path, headers, body }
let script = []; // reply names, one per request
const server = createServer(async (req, res) => {
  const parts = [];
  for await (const c of req) parts.push(c);
  const raw = Buffer.concat(parts).toString("utf8");
  const body = raw ? JSON.parse(raw) : null;
  seen.push({ method: req.method, path: req.url, headers: req.headers, body });
  if (req.method === "GET" && req.url.endsWith("/models")) {
    const key = String(req.headers.authorization || "").replace(/^Bearer /, "");
    if (key === "bad") {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify([{ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }]));
    }
    const ids = key === "renamed" ? ["models/gemini-9-flash", "models/gemini-9-pro", "models/gemini-9-pro-tts", "models/embedding-001"] : ["models/gemini-3.8-flash", "models/gemini-4-argon", "models/gemini-3.5-flash-lite"];
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "google" })) }));
  }
  const name = script.shift();
  if (name?.startsWith("recorded:")) {
    // A real reply from Gemini, replayed byte for byte.
    const file = name.slice("recorded:".length);
    if (file.endsWith(".json")) {
      res.writeHead(503, { "content-type": "application/json", "retry-after": "0.01" });
      return res.end(recorded(file));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    return res.end(recorded(file));
  }
  if (name === "busy503") {
    res.writeHead(503, { "content-type": "application/json", "retry-after": "0.01" });
    return res.end(JSON.stringify([{ error: { code: 503, message: "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.", status: "UNAVAILABLE" } }]));
  }
  if (name === "quota429") {
    res.writeHead(429, { "content-type": "application/json" });
    return res.end(JSON.stringify([{ error: { code: 429, message: "You exceeded your current quota, please check your plan and billing details.", status: "RESOURCE_EXHAUSTED" } }]));
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of REPLIES[name] || []) res.write(frame(c));
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/v1beta/openai`;
after(() => server.close());

const CREDS = { apiKey: "AIza-test", baseUrl: BASE, flavor: "gemini" };
const TOOLS = [
  { name: "inspect", description: "Inspect.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "render", description: "Render.", input_schema: { type: "object", properties: {}, required: [] } },
  { name: "edit", description: "Edit.", input_schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } },
];

test("Gemini is inferred from Google's host; the request uses its key, thinking level and output room", () => {
  assert.equal(inferFlavor(GEMINI.baseUrl), "gemini");
  assert.equal(inferFlavor("https://generativelanguage.googleapis.com/v1beta/openai/"), "gemini");
  assert.equal(inferFlavor("https://openrouter.ai/api/v1"), "openrouter");
  assert.equal(GEMINI.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
});

test("a tool call's signature is kept on its tool_use block, and only there", async () => {
  script = ["step1"];
  const r = await openai.stream({ system: "sys", messages: [{ role: "user", content: "Look." }], tools: TOOLS, model: "gemini-4-argon", effort: "high", creds: CREDS });
  const req = seen.at(-1);
  assert.equal(req.path, "/v1beta/openai/chat/completions");
  assert.equal(req.headers.authorization, "Bearer AIza-test");
  assert.equal(req.body.reasoning_effort, "high");
  assert.equal(req.body.max_tokens, 32768);
  assert.ok(!("reasoning" in req.body) && !("max_completion_tokens" in req.body) && !("temperature" in req.body));
  assert.equal(r.stopReason, "tool_use");
  assert.deepEqual(r.content, [
    { type: "tool_use", id: "function-call-1", name: "inspect", input: {}, extra_content: { google: { thought_signature: SIG_A } } },
    { type: "tool_use", id: "function-call-2", name: "render", input: {} },
  ]);
});

test("the next request sends each signature back on its own call; unsigned steps get the skip placeholder", async () => {
  const history = [
    { role: "user", content: "Look." },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "function-call-1", name: "inspect", input: {}, extra_content: { google: { thought_signature: SIG_A } } },
        { type: "tool_use", id: "function-call-2", name: "render", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "function-call-1", content: "state" }, { type: "tool_result", tool_use_id: "function-call-2", content: "rendered" }] },
    // An earlier step made by another model (no signature at all).
    { role: "assistant", content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "call_x", name: "inspect", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_x", content: "state" }] },
    { role: "assistant", content: [{ type: "extra_content", extra_content: { google: { thought_signature: TEXT_SIG } } }, { type: "text", text: "Done." }] },
    { role: "user", content: "Now rename it." },
  ];
  const snapshot = structuredClone(history);
  script = ["final"];
  await openai.stream({ system: "sys", messages: history, tools: TOOLS, model: "gemini-4-argon", creds: CREDS });
  const msgs = seen.at(-1).body.messages;
  assert.deepEqual(msgs.map((m) => m.role), ["system", "user", "assistant", "tool", "tool", "assistant", "tool", "assistant", "user"]);
  assert.deepEqual(msgs[2].tool_calls[0].extra_content, { google: { thought_signature: SIG_A } }, "signed call keeps its own signature");
  assert.ok(!("extra_content" in msgs[2].tool_calls[1]), "the parallel call had none and gets none");
  assert.deepEqual(msgs[5].tool_calls[0].extra_content, { google: { thought_signature: GEMINI_SKIP_SIGNATURE } }, "unsigned step: placeholder on its first call");
  assert.deepEqual(msgs[7], { role: "assistant", content: "Done.", extra_content: { google: { thought_signature: TEXT_SIG } } }, "a signature on text goes back on that message");
  assert.deepEqual(history, snapshot, "the stored history is never mutated");

  // Other flavors never see Gemini's fields.
  for (const flavor of ["openrouter", "openai", "generic"]) {
    script = ["final"];
    await openai.stream({ system: "sys", messages: history, tools: TOOLS, model: "m", creds: { apiKey: "k", baseUrl: BASE, flavor } });
    assert.ok(!JSON.stringify(seen.at(-1).body.messages).includes("extra_content"), `${flavor}: no extra_content`);
  }
});

test("a full turn: signatures survive the loop's history, call ids stay unique, the answer arrives", async () => {
  script = ["step1", "step2", "final"];
  const calls = [];
  const bridge = {
    label: "Illustrator",
    capabilities: { inspect: true, edit: true, render: true, export: [], save: [] },
    inspect: async () => ({ text: "1 layer", image: null }),
    render: async () => ({ note: "artboard", image: { media_type: "image/png", data: "iVBORw0KGgo=" } }),
    edit: async (code) => (calls.push(code), { ok: true, result: null, logs: [] }),
    selection: async () => null,
  };
  const events = [];
  let saved = null;
  const n = seen.length;
  const messages = await runTurn({
    app: "illustrator",
    userText: "Rename the first layer to Hi.",
    emit: (e) => events.push(e),
    provider: openai,
    creds: CREDS,
    model: "gemini-4-argon",
    effort: "medium",
    bridge,
    save: (m) => (saved = m),
  });
  assert.equal(seen.length - n, 3, "three model requests");
  assert.deepEqual(calls, ["app.activeDocument.layers[0].name='Hi';"]);

  // Step 2's reply reused "function-call-1": it got a fresh id, so the UI and the results can tell them apart.
  const ids = messages.filter((m) => m.role === "assistant").flatMap((m) => m.content.filter((b) => b.type === "tool_use").map((b) => b.id));
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3, `unique ids: ${ids}`);
  const runs = events.filter((e) => e.type === "tool_run").map((e) => e.id);
  const dones = events.filter((e) => e.type === "tool_done").map((e) => e.id);
  assert.deepEqual(runs, ids);
  assert.deepEqual(dones, ids);

  // The third request carried both signatures back, each on the call it came with.
  const third = seen.at(-1).body.messages;
  const assistants = third.filter((m) => m.role === "assistant");
  assert.equal(assistants[0].tool_calls[0].extra_content.google.thought_signature, SIG_A);
  assert.equal(assistants[1].tool_calls[0].extra_content.google.thought_signature, SIG_B);
  assert.equal(assistants[1].tool_calls[0].id, ids[2]);
  assert.equal(third.find((m) => m.role === "tool" && m.tool_call_id === ids[2])?.content, "edit applied.");

  const final = events.find((e) => e.type === "final");
  assert.equal(final.text, "Renamed the first layer to Hi.");
  assert.equal(saved, messages);
  assert.deepEqual(messages.at(-1).content[0], { type: "extra_content", extra_content: { google: { thought_signature: TEXT_SIG } } });
});

test("a busy model (503, high demand) is tried again; a quota refusal is not", async () => {
  script = ["busy503", "busy503", "final"];
  const events = [];
  const n = seen.length;
  const r = await openai.stream({ system: "sys", messages: [{ role: "user", content: "hi" }], model: "gemini-3.8-flash", creds: CREDS, onEvent: (e) => events.push(e) });
  assert.equal(seen.length - n, 3, "two retries, then the answer");
  assert.equal(r.content.find((b) => b.type === "text").text, "Renamed the first layer to Hi.");
  assert.equal(events.filter((e) => e.type === "warning").length, 2);

  script = ["quota429", "final"];
  const m = seen.length;
  const err = await openai.stream({ system: "sys", messages: [{ role: "user", content: "hi" }], model: "gemini-4-argon", creds: CREDS }).then(() => null, (e) => e);
  assert.equal(seen.length - m, 1, "no retry on a quota refusal");
  assert.equal(openai.explainError(err).code, "quota");
  script = [];

  const busy = Object.assign(new Error("x"), { status: 503, detail: "This model is currently experiencing high demand." });
  assert.deepEqual(openai.explainError(busy), { message: "The model is overloaded right now (high demand). Try again in a minute.", code: "overloaded" });
});

test("real Gemini replies (recorded): the signed tool call, then the next step with the signature back", async () => {
  script = ["recorded:busy-503.json", "recorded:inspect-call.sse"];
  const r1 = await openai.stream({ system: "sys", messages: [{ role: "user", content: "Make the title red." }], tools: TOOLS, model: "gemini-3.8-flash", effort: "low", creds: CREDS });
  // Gemini ends a tool step with finish_reason "stop"; the call still makes it a tool step.
  assert.equal(r1.stopReason, "tool_use");
  assert.deepEqual(r1.content, [{ type: "tool_use", id: "call_254099085606045336", name: "inspect", input: {}, extra_content: { google: { thought_signature: "RECORDED_SIGNATURE" } } }]);

  const history = [
    { role: "user", content: "Make the title red." },
    { role: "assistant", content: r1.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: r1.content[0].id, content: "1 text frame" }] },
  ];
  script = ["recorded:edit-call.sse"];
  const r2 = await openai.stream({ system: "sys", messages: history, tools: TOOLS, model: "gemini-3.8-flash", effort: "low", creds: CREDS });
  const sent = seen.at(-1).body.messages;
  assert.deepEqual(sent.find((m) => m.role === "assistant").tool_calls[0].extra_content, { google: { thought_signature: "RECORDED_SIGNATURE" } });
  const call = r2.content.find((b) => b.type === "tool_use");
  assert.equal(call.name, "edit");
  assert.match(call.input.code, /fillColor = c/);
  assert.match(call.input.explanation, /title/i);
  assert.equal(call.extra_content.google.thought_signature, "RECORDED_SIGNATURE");
});

test("this process waits for slow replies: Node's fetch pool is swapped for one with long timeouts", async () => {
  const KEY = Symbol.for("undici.globalDispatcher.1");
  assert.equal(await allowSlowReplies({ minutes: 20 }), true);
  const agent = globalThis[KEY];
  assert.equal(agent.__komposit, true);
  assert.equal(await allowSlowReplies(), false, "only once");
  const r = await fetch(`${BASE}/models`, { headers: { authorization: "Bearer good" } });
  assert.equal(r.status, 200, "fetch still works through it");
});

test("errors read plainly: a refused key says so and offers Settings", async () => {
  const e = Object.assign(new Error("Model request failed (400): API key not valid"), { status: 400, detail: '[{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}]' });
  assert.deepEqual(openai.explainError(e), { message: "The API key was not accepted by the AI service. Check it in Settings.", code: "auth" });
  assert.equal(openai.explainError(Object.assign(new Error("x"), { status: 429 })).code, "rate_limit");
  assert.equal(openai.explainError(Object.assign(new Error("x"), { status: 503 })).code, "server");
  const other = Object.assign(new Error("Model request failed (400): bad schema"), { status: 400, detail: "bad schema" });
  assert.deepEqual(openai.explainError(other), { message: "Model request failed (400): bad schema", code: "bad_request" });
  assert.deepEqual(openai.explainError(new Error("Could not reach x")), { message: "Could not reach x", code: null });
});

test("the key check picks the best model the key can really use, and a fast one for titles", async () => {
  const all = { probe: async () => ({ usable: true }) };
  // Without billing, Pro-class models are listed but have no quota.
  const noBilling = { probe: async (k, id) => (/argon|pro/.test(id) ? { usable: false, status: 429, quota: true } : { usable: true }) };
  let r = await checkGeminiKey("good", { baseUrl: BASE, ...all });
  assert.deepEqual(r, { ok: true, model: "gemini-4-argon", titleModel: "gemini-3.8-flash", pinned: false });
  r = await checkGeminiKey("good", { baseUrl: BASE, ...noBilling });
  assert.deepEqual(r, { ok: true, model: "gemini-3.8-flash", titleModel: "gemini-3.8-flash", pinned: false });
  r = await checkGeminiKey("good", { baseUrl: BASE, model: "models/gemini-3.8-flash", ...all });
  assert.deepEqual(r, { ok: true, model: "gemini-3.8-flash", titleModel: "gemini-3.8-flash", pinned: true });
  r = await checkGeminiKey("good", { baseUrl: BASE, model: "gemini-4-argon", ...noBilling });
  assert.equal(r.ok, false);
  assert.match(r.error, /billing/);
  r = await checkGeminiKey("good", { baseUrl: BASE, model: "gemini-0-nope", ...all });
  assert.equal(r.ok, false);
  assert.match(r.error, /can't use gemini-0-nope/);
  r = await checkGeminiKey("good", { baseUrl: BASE, probe: async () => ({ usable: false, quota: true }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /can't use any Gemini model/);
  // Models renamed since this build: the newest general model, Pro-class first, never TTS.
  r = await checkGeminiKey("renamed", { baseUrl: BASE, ...all });
  assert.deepEqual(r, { ok: true, model: "gemini-9-pro", titleModel: "gemini-9-pro", pinned: false });
  r = await checkGeminiKey("bad", { baseUrl: BASE, ...all });
  assert.deepEqual(r, { ok: false, error: "That key was not accepted by Google." });
  r = await checkGeminiKey("x", { baseUrl: "http://127.0.0.1:9", ...all });
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not reach Google/);
});

test("a model check stops at the first sign of an answer and reads quota refusals", async () => {
  const { modelAnswers } = await import("../providers/keys.mjs");
  const real = globalThis.fetch;
  let aborted = false;
  try {
    globalThis.fetch = async (url, init) => {
      init.signal.addEventListener("abort", () => (aborted = true));
      return new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    assert.deepEqual(await modelAnswers("k", "gemini-3.8-flash", BASE), { usable: true, status: 200, quota: false });
    assert.ok(aborted, "the reply is stopped after the check");
    globalThis.fetch = async () => new Response(JSON.stringify([{ error: { code: 429, message: "You exceeded your current quota", status: "RESOURCE_EXHAUSTED" } }]), { status: 429 });
    assert.deepEqual(await modelAnswers("k", "gemini-4-argon", BASE), { usable: false, status: 429, quota: true });
    // Still thinking after the wait: no refusal came, so it's usable.
    globalThis.fetch = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    assert.deepEqual(await modelAnswers("k", "gemini-4-argon", BASE, { waitMs: 50 }), { usable: true, status: null });
  } finally {
    globalThis.fetch = real;
  }
  const quota = Object.assign(new Error("Model request failed (429)"), { status: 429, detail: "RESOURCE_EXHAUSTED: quota" });
  assert.equal(openai.explainError(quota).code, "quota");
});

test("chat titles go to Google with the fast model and little thinking", async () => {
  const real = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Rename the first layer" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const title = await nameChat({ mode: "gemini", gemini: { apiKey: "AIza-test", model: "gemini-4-argon", titleModel: "gemini-3.8-flash" } }, { text: "rename the first layer to Hi", app: "illustrator" });
    assert.equal(title, "Rename the first layer");
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(sent.url, `${GEMINI.baseUrl}/chat/completions`);
  assert.equal(sent.headers.Authorization, "Bearer AIza-test");
  assert.equal(sent.body.model, "gemini-3.8-flash");
  assert.equal(sent.body.reasoning_effort, "low");
  assert.equal(sent.body.max_tokens, 1000);
});
