// The bridge API the web page uses when it runs the agent loop itself:
// POST /api/tool (one tool call), POST /api/turn/start and /api/turn/record
// (recording the page's turn in the chat store). Runs the real server on a
// free port with a throwaway data folder; no Adobe app is touched (the one
// tool that runs, Photoshop preflight, answers before reaching the app).
//
//   node --test companion/test/bridge-api.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOSTED = "https://app.komposit.werq.dev";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==";
const LEASE_MS = 1500;

let server, port, token, dataDir;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "komposit-bridge-"));
  // A port of its own: 4321 may be the person's own Komposit.
  server = spawn(process.execPath, [join(ROOT, "companion", "server.mjs")], {
    env: { ...process.env, PORT: "4351", KOMPOSIT_DATA_DIR: dataDir, KOMPOSIT_PAGE_LEASE_MS: String(LEASE_MS), KOMPOSIT_SKIP_SELECTION: "1", MODEL_PROVIDER: "", ANTHROPIC_API_KEY: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  port = await new Promise((resolve, reject) => {
    let out = "";
    server.stdout.on("data", (d) => {
      out += d;
      const m = /KOMPOSIT_READY port=(\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
    setTimeout(() => reject(new Error("server did not start")), 15000);
  });
  token = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).token;
});

after(() => {
  server?.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

// A raw HTTP request, so Host and Origin can be anything.
function request(path, { method = "POST", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers, ...(data ? { "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const authed = (extra = {}) => ({ authorization: `Bearer ${token}`, "content-type": "application/json", ...extra });
const api = (path, body, extra) => request(path, { headers: authed(extra), body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PREFLIGHT = { app: "photoshop", name: "preflight", input: {} };

test("POST /api/tool keeps all four locks", async () => {
  // Host: DNS rebinding.
  let r = await request("/api/tool", { headers: authed({ host: "evil.example:80" }), body: PREFLIGHT });
  assert.equal(r.status, 421);
  // Origin: any site but the local page and the hosted UI.
  r = await request("/api/tool", { headers: authed({ origin: "https://evil.example" }), body: PREFLIGHT });
  assert.equal(r.status, 403);
  // Token.
  r = await request("/api/tool", { headers: { "content-type": "application/json" }, body: PREFLIGHT });
  assert.equal(r.status, 401);
  r = await request("/api/tool", { headers: authed({ authorization: "Bearer wrong" }), body: PREFLIGHT });
  assert.equal(r.status, 401);
  // JSON only: a form or a text/plain beacon can't trigger it.
  r = await request("/api/tool", { headers: authed({ "content-type": "text/plain" }), body: JSON.stringify(PREFLIGHT) });
  assert.equal(r.status, 415);
  r = await request("/api/tool", { headers: authed({ "content-type": "application/x-www-form-urlencoded" }), body: "app=photoshop" });
  assert.equal(r.status, 415);
  // Bad JSON.
  r = await request("/api/tool", { headers: authed(), body: "{not json" });
  assert.equal(r.status, 400);
  // A preflight from a foreign origin gets nothing.
  r = await request("/api/tool", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
  assert.equal(r.status, 403);
});

test("the hosted page and the local page may call it; the result is the tool result", async () => {
  const pre = await request("/api/tool", { method: "OPTIONS", headers: { origin: HOSTED, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers["access-control-allow-origin"], HOSTED);
  assert.equal(pre.headers["access-control-allow-private-network"], "true");

  for (const origin of [HOSTED, `http://127.0.0.1:${port}`]) {
    const r = await api("/api/tool", PREFLIGHT, { origin });
    assert.equal(r.status, 200);
    assert.equal(r.headers["access-control-allow-origin"], origin);
    assert.equal(r.json.is_error, true);
    assert.match(String(r.json.content), /preflight is available in Illustrator only/);
    assert.equal(r.json.meta.display, "no preflight here");
  }
});

test("bad calls are answered, not run: unknown app, unknown tool, invalid input", async () => {
  let r = await api("/api/tool", { app: "premiere", name: "inspect", input: {} });
  assert.equal(r.status, 400);
  r = await api("/api/tool", { app: "illustrator", name: "format_disk", input: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.is_error, true);
  assert.match(r.json.content, /^INVALID_INPUT: unknown tool format_disk/);
  r = await api("/api/tool", { app: "illustrator", name: "export", input: { format: "tiff" } });
  assert.match(r.json.content, /^INVALID_INPUT: "format" must be one of/);
  r = await api("/api/tool", { app: "illustrator", name: "edit", input: "app.quit()" });
  assert.match(r.json.content, /^INVALID_INPUT: input must be an object/);
});

test("with Accept: text/event-stream the result comes as an event", async () => {
  const r = await api("/api/tool", PREFLIGHT, { accept: "text/event-stream" });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /text\/event-stream/);
  const events = r.text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5)));
  assert.equal(events.at(-1).type, "result");
  assert.equal(events.at(-1).is_error, true);
});

test("a turn the page runs is recorded like any other", async () => {
  let r = await api("/api/turn/start", { engine: "gemini", family: "openai", app: "photoshop", effort: "high", text: "Make the title red", images: [{ media_type: "image/png", data: PNG }] });
  assert.equal(r.status, 200, r.text);
  const { chatId, turnId } = r.json;
  assert.match(chatId, /^c_/);
  assert.equal(r.json.isNew, true);
  assert.ok(r.json.text.endsWith("Make the title red"));
  assert.deepEqual(r.json.history, []);
  assert.equal(r.json.userImages.length, 1);
  assert.ok(["Cmd", "Ctrl"].includes(r.json.mod));

  // Busy: the same chat can't start another turn meanwhile.
  r = await api("/api/turn/start", { engine: "gemini", family: "openai", app: "photoshop", text: "again", chatId });
  assert.equal(r.status, 409);

  // A tool call for this turn.
  r = await api("/api/tool", { ...PREFLIGHT, chatId, turnId });
  assert.equal(r.status, 200);

  const history = [
    { role: "user", content: [{ type: "text", text: "[App: Photoshop]\n\nMake the title red" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "edit", input: { code: "x()" } }] },
  ];
  r = await api("/api/turn/record", {
    chatId,
    turnId,
    events: [
      { type: "note", text: "Looking for the title." },
      { type: "tool_run", id: "call_1", name: "edit", input: { code: "x()", explanation: "make the title red" } },
      { type: "tool_done", id: "call_1", name: "edit", is_error: false, display: "make the title red", image: { media_type: "image/png", data: PNG } },
      { type: "text", delta: "not recorded" },
      { type: "bogus", text: "ignored" },
    ],
    history: { from: 0, messages: history },
  });
  assert.equal(r.status, 200, r.text);
  // The page gets the same normalized events a turn run here streams.
  assert.deepEqual(r.json.events.map((e) => e.type), ["note", "step", "step_done"]);
  assert.equal(r.json.events[1].label, "Make the title red");
  assert.match(r.json.events[2].imageUrl, new RegExp(`^/api/chats/${chatId}/img/render-`));
  const tail = [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "edit applied." }] },
    { role: "assistant", content: [{ type: "text", text: "The title is red now." }] },
  ];
  r = await api("/api/turn/record", { chatId, turnId, events: [{ type: "final", text: "The title is red now." }, { type: "timing", modelMs: 1234 }], history: { from: 2, messages: tail }, end: { status: "done" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "done");
  assert.deepEqual(r.json.events.map((e) => e.type), ["final", "done"]);

  const chat = JSON.parse(readFileSync(join(dataDir, "chats", chatId, "chat.json"), "utf8"));
  const turn = chat.turns[0];
  assert.equal(turn.engine, "gemini");
  assert.equal(turn.status, "done");
  assert.equal(turn.final, "The title is red now.");
  assert.equal(turn.modelMs, 1234);
  assert.equal(turn.user.images.length, 1);
  const tools = turn.steps.filter((s) => s.kind === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].label, "Make the title red");
  assert.equal(tools[0].status, "done");
  assert.match(tools[0].image, /^render-.*\.png$/);
  assert.ok(turn.steps.some((s) => s.kind === "note" && s.text === "Looking for the title."));
  assert.equal(chat.apiFamily, "openai");
  const api_ = JSON.parse(readFileSync(join(dataDir, "chats", chatId, "api.json"), "utf8"));
  assert.deepEqual(api_, [...history, ...tail]);

  // Over: further calls for it are refused, so a stale page stops.
  r = await api("/api/turn/record", { chatId, turnId, events: [] });
  assert.equal(r.status, 409);
  r = await api("/api/tool", { ...PREFLIGHT, chatId, turnId });
  assert.equal(r.status, 409);

  // The next turn gets the stored history; another family starts it afresh.
  r = await api("/api/turn/start", { engine: "gemini", family: "openai", app: "photoshop", text: "And bigger", chatId });
  assert.equal(r.json.history.length, 4);
  assert.equal(r.json.isNew, false);
  await api("/api/turn/record", { chatId, turnId: r.json.turnId, events: [], end: { status: "done" } });
  r = await api("/api/turn/start", { engine: "anthropic", family: "anthropic", app: "photoshop", text: "Now on Claude", chatId });
  assert.deepEqual(r.json.history, []);
  await api("/api/turn/record", { chatId, turnId: r.json.turnId, events: [{ type: "aborted" }], end: { status: "stopped" } });
  const after = JSON.parse(readFileSync(join(dataDir, "chats", chatId, "chat.json"), "utf8"));
  assert.equal(after.turns.at(-1).status, "stopped");
});

test("bad starts and records are refused", async () => {
  let r = await api("/api/turn/start", { engine: "claude-code", app: "photoshop", text: "hi" });
  assert.equal(r.status, 400, "subscriptions run in the app, not the page");
  r = await api("/api/turn/start", { engine: "gemini", app: "photoshop", text: "  " });
  assert.equal(r.status, 400);
  r = await api("/api/turn/start", { engine: "gemini", family: "openai", app: "photoshop", text: "x" });
  const { chatId, turnId } = r.json;
  r = await api("/api/turn/record", { chatId, turnId: "t_wrong", events: [] });
  assert.equal(r.status, 409);
  r = await api("/api/turn/record", { chatId, turnId, history: { from: 5, messages: [] } });
  assert.equal(r.status, 400, "history can't start past its end");
  // Stop from anywhere (another tab, the app) ends it at once.
  r = await api("/api/stop", { chatId });
  assert.equal(r.json.ok, true);
  r = await api("/api/turn/record", { chatId, turnId, events: [] });
  assert.equal(r.status, 409);
  const chat = JSON.parse(readFileSync(join(dataDir, "chats", chatId, "chat.json"), "utf8"));
  assert.equal(chat.turns.at(-1).status, "stopped");
});

test("a page that goes quiet loses its turn (the tab was closed)", async () => {
  let r = await api("/api/turn/start", { engine: "anthropic", family: "anthropic", app: "illustrator", text: "Tab closes now" });
  const { chatId, turnId } = r.json;
  await api("/api/turn/record", { chatId, turnId, events: [{ type: "tool_run", id: "c1", name: "inspect", input: {} }] });
  // Heartbeats keep it alive past the lease...
  for (let i = 0; i < 3; i++) {
    await sleep(LEASE_MS / 2);
    r = await api("/api/turn/record", { chatId, turnId, events: [] });
    assert.equal(r.status, 200);
  }
  // ...silence ends it.
  await sleep(LEASE_MS + 600);
  r = await api("/api/turn/record", { chatId, turnId, events: [] });
  assert.equal(r.status, 409);
  const chat = JSON.parse(readFileSync(join(dataDir, "chats", chatId, "chat.json"), "utf8"));
  const turn = chat.turns.at(-1);
  assert.equal(turn.status, "stopped");
  assert.equal(turn.stopReason, "page_closed");
  assert.equal(turn.steps.find((s) => s.id === "c1").status, "stopped");
});

test("a page naming a new chat never overrides a name the person gave it", async () => {
  let r = await api("/api/turn/start", { engine: "gemini", family: "openai", app: "illustrator", text: "make a poster for the jazz night" });
  const { chatId, turnId, title } = r.json;
  r = await api(`/api/chats/${chatId}/rename`, { title: "Jazz night poster", ifTitle: title });
  assert.equal(r.status, 200);
  r = await api(`/api/chats/${chatId}/rename`, { title: "Something else", ifTitle: title });
  assert.equal(r.status, 409);
  assert.equal(r.json.title, "Jazz night poster");
  await api("/api/turn/record", { chatId, turnId, events: [], end: { status: "done" } });
  const chat = JSON.parse(readFileSync(join(dataDir, "chats", chatId, "chat.json"), "utf8"));
  assert.equal(chat.title, "Jazz night poster", "the running turn's save keeps the new name");
});

test("status tells the page what this app can do", async () => {
  const r = await request("/api/status", { method: "GET", headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(r.json.features, ["tool", "page-turns"]);
  assert.ok(["Cmd", "Ctrl"].includes(r.json.mod));
});
