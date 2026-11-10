// The agent loop as the hosted page runs it: web/harness.mjs bundled for the
// browser (the same esbuild step as the deploy), then run in a bare context
// with only what a browser page has. No process, require, Buffer, module or
// global, so a Node API anywhere in the loop or the providers fails here.
// Models are reached through a stubbed fetch; tools through a fake runTool.
//
//   node --test companion/test/page-harness.test.mjs
// Needs web/'s dev dependencies (cd web && npm ci) for esbuild; skipped without them.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webcrypto } from "node:crypto";

let H = null; // window.KompositHarness, from inside the page context
let page = null; // that context
let skip = false;
let bundleText = "";
const seen = []; // requests the stubbed fetch got: { url, headers, body }
let answer = () => new Response("no stub", { status: 500 });

before(async () => {
  let bundleHarness;
  try {
    ({ bundleHarness } = await import("../../web/build.mjs"));
    await import("esbuild").catch(async () => {
      // esbuild lives in web/node_modules; resolve it from there.
      await import(new URL("../../web/node_modules/esbuild/lib/main.js", import.meta.url));
    });
  } catch {
    skip = true;
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "komposit-harness-"));
  try {
    const { outfile } = await bundleHarness({ outfile: join(dir, "harness.js"), minify: false });
    bundleText = readFileSync(outfile, "utf8");
  } catch (e) {
    if (/Cannot find (package|module) 'esbuild'/.test(String(e.message))) {
      skip = true;
      return;
    }
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // A page: browser globals only.
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    ReadableStream,
    Response,
    Request,
    Headers,
    FormData,
    Blob,
    Event,
    EventTarget,
    DOMException,
    crypto: webcrypto,
    navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0 Safari/537.36", language: "en-US" },
    location: new URL("https://app.komposit.werq.dev/"),
    document: { createElement: () => ({}) },
    fetch: async (url, init = {}) => {
      const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
      seen.push({ url: String(url), headers, body: init.body ? JSON.parse(String(init.body)) : null, method: init.method || "GET" });
      return answer(String(url), init);
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  page = vm.createContext(sandbox);
  vm.runInContext(bundleText, page, { filename: "harness.js" });
  H = page.KompositHarness;
});

const maybe = (name, fn) => test(name, async (t) => (skip ? t.skip("web/ dev dependencies not installed (cd web && npm ci)") : fn(t)));

// An SSE body, as a model API streams it.
const sse = (frames) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const f of frames) c.enqueue(new TextEncoder().encode(f));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_page" } },
  );

// The Anthropic wire format for one message.
function anthropicStream(content, stop_reason) {
  const ev = [{ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }];
  content.forEach((b, index) => {
    if (b.type === "thinking") {
      ev.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      ev.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking } });
      ev.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature } });
    } else if (b.type === "text") {
      ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else if (b.type === "tool_use") {
      ev.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    ev.push({ type: "content_block_stop", index });
  });
  ev.push({ type: "message_delta", delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 42 } });
  ev.push({ type: "message_stop" });
  return sse(ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
}

const fakeTools = () => {
  const calls = [];
  const runTool = async (name, input, { id }) => {
    calls.push({ name, input, id });
    if (name === "render") return { content: [{ type: "text", text: "Rendered (artboard)." }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }], is_error: false, meta: { display: "rendered to check", image: { media_type: "image/png", data: "iVBORw0KGgo=" } } };
    return { content: "edit applied.", is_error: false, meta: { display: input.explanation || "applied an edit" } };
  };
  return { calls, runTool };
};

maybe("the bundle is self-contained: nothing from Node, and the page sees the harness", () => {
  assert.ok(H, "window.KompositHarness is defined");
  assert.equal(H.version, 1);
  for (const name of ["runTurn", "apiTurnConfig", "nameChat"]) assert.equal(typeof H[name], "function", name);
  assert.equal(typeof page.process, "undefined");
  assert.equal(typeof page.require, "undefined");
  assert.equal(typeof page.Buffer, "undefined");
  assert.ok(!/\brequire\(["']node:/.test(bundleText), "no node: requires");
  assert.ok(!/from ["']node:/.test(bundleText), "no node: imports");
});

maybe("Claude through the SDK, from the page: the browser header, thinking kept, tools through runTool", async () => {
  const turns = [
    anthropicStream([{ type: "thinking", thinking: "Make it red.", signature: "sig-1" }, { type: "tool_use", id: "toolu_1", name: "edit", input: { code: "app.activeDocument.layers[0].name='Red';", explanation: "Make the title red" } }], "tool_use"),
    anthropicStream([{ type: "text", text: "The title is red now." }], "end_turn"),
  ];
  answer = () => turns.shift();
  const n = seen.length;
  const { calls, runTool } = fakeTools();
  const events = [];
  const cfg = H.apiTurnConfig({ mode: "anthropic", anthropic: { apiKey: "sk-ant-page" } });
  assert.equal(cfg.family, "anthropic");
  const history = await H.runTurn({ app: "illustrator", history: [], userText: "Make the title red", provider: cfg.provider, creds: cfg.creds, model: cfg.model, effort: "low", mod: "Cmd", runTool, emit: (e) => events.push(e) });
  const reqs = seen.slice(n);
  assert.equal(reqs.length, 2);
  assert.match(reqs[0].url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.equal(reqs[0].headers.authorization, "Bearer sk-ant-page"); // SDK 1.3 sends the key as a bearer token
  assert.equal(reqs[0].headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(reqs[0].body.model, "claude-opus-5-5");
  assert.deepEqual(reqs[0].body.output_config, { effort: "low" });
  assert.match(reqs[0].body.system[0].text, /Cmd\+Z/);
  // The thinking block went back exactly as received.
  assert.deepEqual(reqs[1].body.messages[1].content[0], { type: "thinking", thinking: "Make it red.", signature: "sig-1" });
  assert.deepEqual(calls.map((c) => [c.name, c.id]), [["edit", "toolu_1"]]);
  assert.deepEqual(events.map((e) => e.type), ["note", "tool_run", "tool_done", "text", "final", "timing"]);
  assert.equal(events.find((e) => e.type === "final").text, "The title is red now.");
  assert.equal(history.length, 4);
});

maybe("Windows prompts say Ctrl, from the same bundle", async () => {
  answer = () => anthropicStream([{ type: "text", text: "Hi." }], "end_turn");
  const n = seen.length;
  const cfg = H.apiTurnConfig({ mode: "anthropic", anthropic: { apiKey: "k" } });
  await H.runTurn({ app: "photoshop", history: [], userText: "hi", provider: cfg.provider, creds: cfg.creds, model: cfg.model, mod: "Ctrl", runTool: async () => ({}) });
  const body = seen.slice(n)[0].body;
  assert.match(body.system[0].text, /Ctrl\+Z/);
  assert.ok(!/Cmd\+/.test(body.system[0].text));
  assert.match(body.tools.find((t) => t.name === "save").description, /like Ctrl\+S/);
});

maybe("Gemini from the page: the reader-based stream, signatures back on the next request", async () => {
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const turns = [
    sse([chunk({ tool_calls: [{ index: 0, id: "function-call-1", type: "function", function: { name: "render", arguments: "{}" }, extra_content: { google: { thought_signature: "SIG" } } }] }), chunk({}, "tool_calls"), "data: [DONE]\n\n"]),
    sse([chunk({ content: "Looks good." }), chunk({}, "stop"), "data: [DONE]\n\n"]),
  ];
  answer = () => turns.shift();
  const n = seen.length;
  const { runTool } = fakeTools();
  const events = [];
  const cfg = H.apiTurnConfig({ mode: "gemini", gemini: { apiKey: "AIza-page", model: "gemini-4-argon" } });
  assert.equal(cfg.family, "openai");
  await H.runTurn({ app: "photoshop", history: [], userText: "check it", provider: cfg.provider, creds: cfg.creds, model: cfg.model, effort: "medium", mod: "Cmd", runTool, emit: (e) => events.push(e) });
  const reqs = seen.slice(n);
  assert.equal(reqs[0].url, `${H.GEMINI.baseUrl}/chat/completions`);
  assert.equal(reqs[0].headers.authorization, "Bearer AIza-page");
  assert.equal(reqs[0].body.reasoning_effort, "medium");
  assert.equal(reqs[1].body.messages.find((m) => m.role === "assistant").tool_calls[0].extra_content.google.thought_signature, "SIG");
  assert.equal(events.find((e) => e.type === "tool_done").image.media_type, "image/png");
  assert.equal(events.find((e) => e.type === "final").text, "Looks good.");
});

maybe("the invite gateway and a signed-in account go through the same Anthropic path", () => {
  const plain = (o) => JSON.parse(JSON.stringify(o)); // objects from the page's realm
  const inv = H.apiTurnConfig({ mode: "invite", invite: { code: "kp_x" } });
  assert.deepEqual(plain(inv.creds), { apiKey: "kp_x", baseUrl: "https://gateway.komposit.werq.dev" });
  const acc = H.apiTurnConfig({ mode: "account", account: { session: "ks_y" } }, { gateway: "https://gw.test" });
  assert.deepEqual(plain(acc.creds), { apiKey: "ks_y", baseUrl: "https://gw.test" });
  assert.equal(H.apiTurnConfig({ mode: "claude-code" }), null, "subscriptions run in the app");
});

maybe("chats are named from the page, never throwing", async () => {
  answer = () => new Response(JSON.stringify({ choices: [{ message: { content: "Red title" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  const title = await H.nameChat({ mode: "gemini", gemini: { apiKey: "AIza-page", titleModel: "gemini-3.8-flash" } }, { text: "make the title red", app: "illustrator" });
  assert.equal(title, "Red title");
  answer = () => new Response("nope", { status: 500 });
  assert.equal(await H.nameChat({ mode: "openai", openai: { apiKey: "k", baseUrl: "https://openrouter.ai/api/v1", model: "m" } }, { text: "x" }), "");
});

maybe("keys are checked from the page too", async () => {
  // Listed models, and every model answers (billing on).
  answer = (url) => (url.endsWith("/models") ? new Response(JSON.stringify({ data: [{ id: "models/gemini-4-argon" }, { id: "models/gemini-3.8-flash" }] }), { status: 200 }) : sse(["data: {}\n\n"]));
  assert.deepEqual({ ...(await H.keys.checkGeminiKey("AIza-page")) }, { ok: true, model: "gemini-4-argon", titleModel: "gemini-3.8-flash", pinned: false });
  answer = () => new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 });
  assert.equal((await H.keys.checkGeminiKey("bad")).ok, false);
});
