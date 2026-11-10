// Komposit, the local half. A small HTTP server on 127.0.0.1 that drives the
// Adobe apps and reads design files on this computer, for one UI: either the copy
// it serves itself (http://127.0.0.1:<port>/) or the hosted UI on the web.
//
// Every /api call passes the locks in auth.mjs (host, origin, token, JSON).
// Agent turns run here and stream back as server-sent events, or (API keys
// kept in the hosted page) run in the web page, which calls the model itself
// and this server only for tools (POST /api/tool) and to record the turn
// (POST /api/turn/start, /api/turn/record). Either way each turn is saved to
// the chat store, so the conversation renders the same after a reload.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { config, token, effectiveAI, publicAI, DATA_DIR } from "./config.mjs";
import { guard, hostedUrl, SHELL_HEADERS, webOrigins } from "./auth.mjs";
import { appManifest, getBridge, APPS } from "./bridges/index.mjs";
import { workspaceSnapshot, thumbnail, openFile, browse, saveRender, cachedRender, inHome } from "./desktop.mjs";
import { markRecent, renderOpenFile, markBusy } from "./preview.mjs";
import * as chats from "./chats.mjs";
import * as setup from "./setup.mjs";
import { runTurnFor, withContext, EFFORTS } from "./engines/index.mjs";
import { executeTool, validateToolInput } from "./harness/tools.mjs";
import { env } from "./env.mjs";
import { nameChat } from "./titles.mjs";
import { watchForDialog } from "./dialogwatch.mjs";
import { scratchDir } from "./scratch.mjs";
import platform from "./platform/index.mjs";
import { stepLabel, doneLabel, cleanToolName } from "./labels.mjs";
import { allowSlowReplies } from "./net.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UI_DIR = join(ROOT, "ui");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

// ---------- helpers ----------

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

const MAX_BODY = 160 * 1024 * 1024; // images and attached files arrive as base64
async function readBody(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > MAX_BODY) throw Object.assign(new Error("request too large"), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

const STATIC = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function serveShell(res, port) {
  let html = await readFile(join(UI_DIR, "index.html"), "utf8");
  // The local UI gets the token inline: other origins can't read this page.
  const meta = `<meta name="komposit-token" content="${token()}"><meta name="komposit-port" content="${port}">`;
  html = html.replace("<!--komposit:local-->", meta);
  res.writeHead(200, SHELL_HEADERS);
  res.end(html);
}

async function serveStatic(res, pathname) {
  const name = pathname.replace(/^\/+/, "");
  if (!/^[a-z0-9_-]+(\/[a-z0-9_-]+)*\.[a-z0-9]+$/i.test(name)) return false;
  const type = STATIC[extname(name).toLowerCase()];
  if (!type) return false;
  try {
    const buf = await readFile(join(UI_DIR, name));
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

// ---------- turns ----------

const runningTurns = new Map(); // chatId -> { controller, turnId, chat }

const IMG_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
function cleanImages(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((i) => i && IMG_TYPES.has(i.media_type) && typeof i.data === "string" && i.data.length < 12_000_000)
    .slice(0, 6)
    .map((i) => ({ media_type: i.media_type, data: i.data }));
}

// Attached files of any type: { name, media_type, data(base64) }, up to 6,
// each under ~100 MB. Saved with the chat; the model gets their paths.
function cleanFiles(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((f) => f && typeof f.data === "string" && f.data.length > 0 && f.data.length < 140_000_000)
    .slice(0, 6)
    .map((f) => ({ name: String(f.name || "file").slice(0, 200), media_type: String(f.media_type || ""), data: f.data }));
}

// Start a turn: the chat (new, or the one named), the person's message and
// attachments saved with it, and the turn record. Shared by turns run here and
// turns the web page runs. Returns { status, error } when it can't start.
function beginTurn(body, engine) {
  const app = APPS.includes(body.app) ? body.app : "illustrator";
  const text = String(body.text || "").trim();
  const images = cleanImages(body.images);
  const incoming = cleanFiles(body.files);
  const effort = EFFORTS[body.effort] ? body.effort : "medium";
  if (!text && !images.length && !incoming.length) return { status: 400, error: { error: "empty message" } };

  let chat = body.chatId ? chats.loadChat(body.chatId) : null;
  const isNew = !chat;
  if (!chat) chat = chats.createChat({ app, title: chats.titleFrom(text || incoming[0]?.name || "") });
  if (runningTurns.has(chat.id)) return { status: 409, error: { error: "busy", message: "This chat is still working." } };

  const turn = {
    id: "t_" + randomBytes(5).toString("hex"),
    at: Date.now(),
    app,
    effort,
    engine,
    user: { text, images: images.map((img) => chats.saveImage(chat.id, img, "ref")).filter(Boolean) },
    steps: [],
    final: "",
    status: "running",
  };
  const files = incoming.map((f) => ({ ...chats.saveFile(chat.id, f), media_type: f.media_type })).filter((f) => f.path);
  if (files.length) turn.user.files = files.map((f) => ({ name: f.name, size: f.size }));
  chat.app = app;
  chat.turns.push(turn);
  chats.saveChat(chat);
  return { chat, turn, isNew, app, text, images, files, incoming, effort };
}

// Records one turn's engine events on the chat (plain-language steps, renders
// saved as files, notes, the final message, errors) and hands each one,
// normalized, to `send`: the SSE stream for a turn run here, nothing for a turn
// the web page runs (the page draws its own). `finish` settles the turn.
function turnRecorder({ chat, turn, app, send, watchDialogs = true }) {
  const stepStart = new Map(); // tool id -> t0
  const stepInput = new Map();
  const watchers = new Map(); // step id -> stop() for its dialog watcher
  let lastSave = 0;
  const persist = (force = false) => {
    if (force || Date.now() - lastSave > 1500) {
      lastSave = Date.now();
      chats.saveChat(chat);
    }
  };

  const emit = (ev) => {
    switch (ev.type) {
      case "note": {
        const t = String(ev.text || "").trim();
        if (!t) return;
        turn.steps.push({ kind: "note", text: t });
        send({ type: "note", text: t });
        return persist();
      }
      case "text":
        if (ev.delta) send({ type: "text", delta: ev.delta });
        return;
      case "thinking": // live progress only, not recorded
        send({ type: "thinking", tokens: ev.tokens });
        return;
      case "tool_run": {
        const name = cleanToolName(ev.name);
        stepStart.set(ev.id, Date.now());
        stepInput.set(ev.id, ev.input || {});
        const step = { kind: "tool", id: ev.id, name, label: stepLabel(name, ev.input), status: "running" };
        turn.steps.push(step);
        send({ type: "step", ...step });
        // A dialog in the app blocks the step; say so quietly on the step itself.
        if (watchDialogs) {
          watchers.set(
            ev.id,
            watchForDialog(app, (text) => {
              if (step.status !== "running") return;
              step.waiting = text || undefined;
              send({ type: "step_wait", id: ev.id, text: text || null });
            }),
          );
        }
        return persist();
      }
      case "tool_done": {
        watchers.get(ev.id)?.();
        watchers.delete(ev.id);
        const step = turn.steps.find((s) => s.kind === "tool" && s.id === ev.id);
        if (step) delete step.waiting;
        const name = cleanToolName(ev.name || step?.name);
        const ms = Date.now() - (stepStart.get(ev.id) || Date.now());
        const imageName = ev.image?.data ? chats.saveImage(chat.id, ev.image, "render") : null;
        const videoName = previewVideo(chat.id, ev.video);
        const patch = {
          status: ev.is_error ? "error" : "done",
          label: doneLabel(name, stepInput.get(ev.id), { isError: ev.is_error }),
          ms,
          ...(imageName ? { image: imageName } : {}),
          ...(videoName ? { video: videoName } : {}),
          ...(ev.is_error && ev.display ? { detail: String(ev.display).slice(0, 200) } : {}),
        };
        if (step) Object.assign(step, patch);
        send({ type: "step_done", id: ev.id, ...patch, imageUrl: chats.imageUrl(chat.id, imageName), videoUrl: chats.imageUrl(chat.id, videoName) });
        return persist();
      }
      case "final": {
        const t = String(ev.text || "").trim();
        // Claude Code also reports its last message as a note; keep it once.
        const last = turn.steps[turn.steps.length - 1];
        const dropLastNote = !!(last && last.kind === "note" && last.text === t);
        if (dropLastNote) turn.steps.pop();
        turn.final = t;
        send({ type: "final", text: t, dropLastNote });
        return persist(true);
      }
      case "error":
        turn.error = String(ev.message || "Something went wrong.");
        turn.errorCode = ev.code || null;
        send({ type: "error", message: turn.error, code: ev.code || null });
        return persist(true);
      case "refusal":
        turn.error = "The model declined this request.";
        send({ type: "error", message: turn.error, code: "refusal" });
        return persist(true);
      case "aborted":
        turn.status = "stopped";
        return;
      case "timing":
        turn.modelMs = ev.modelMs || null;
        return;
      default:
        return;
    }
  };

  // The turn is over: stop the dialog watchers, settle its status and save it.
  // Returns the "done" event.
  const finish = ({ aborted = false, started = turn.at } = {}) => {
    for (const stop of watchers.values()) stop();
    watchers.clear();
    turn.durationMs = Date.now() - started;
    if (aborted) turn.status = "stopped";
    else if (turn.error) turn.status = "error";
    else turn.status = "done";
    // Steps still marked running when a turn ends were cut off.
    for (const s of turn.steps) if (s.status === "running") s.status = turn.status === "stopped" ? "stopped" : "error";
    chats.saveChat(chat);
    return { type: "done", status: turn.status, durationMs: turn.durationMs, chatId: chat.id, turnId: turn.id };
  };

  return { emit, finish };
}

// A turn run here: the engine runs in this process and its events stream back.
async function handleTurn(req, res, body) {
  const ai = effectiveAI();
  if (!ai.mode) return json(res, 409, { error: "setup_required", message: "Choose an AI in Settings first." });
  const begun = beginTurn(body, ai.mode);
  if (begun.error) return json(res, begun.status, begun.error);
  const { chat, turn, isNew, app, text, images, files, incoming, effort } = begun;

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  req.socket.setTimeout(0);
  const send = (ev) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  // Long thinking gaps: a comment line every 15 s keeps proxies and fetch alive.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(`: keepalive\n\n`);
  }, 15000);

  const controller = new AbortController();
  runningTurns.set(chat.id, { controller, turnId: turn.id, chat });
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  const started = Date.now();
  const recorder = turnRecorder({ chat, turn, app, send });

  send({
    type: "start",
    chatId: chat.id,
    turnId: turn.id,
    title: chat.title,
    app,
    engine: ai.mode,
    userImages: turn.user.images.map((n) => chats.imageUrl(chat.id, n)),
  });

  // A new chat starts with the first words of the message as its title; the
  // AI names it properly beside the turn (see titles.mjs). A title the person
  // set in the meantime wins.
  if (isNew) {
    const provisional = chat.title;
    nameChat(ai, { text, app, files: incoming.map((f) => f.name) }).then((title) => {
      if (!title || title === provisional) return;
      const live = runningTurns.get(chat.id)?.chat; // a running turn saves its own copy
      const target = live || chats.loadChat(chat.id);
      if (!target || target.title !== provisional) return;
      target.title = title;
      if (!live) chats.saveChat(target);
      send({ type: "title", chatId: chat.id, title });
    });
  }

  markBusy(app, true);
  try {
    await runTurnFor(ai, { chat, turn, app, text, images, files, effort, emit: recorder.emit, signal: controller.signal });
  } catch (e) {
    if (!controller.signal.aborted) recorder.emit({ type: "error", message: e.message });
  } finally {
    markBusy(app, false);
    clearInterval(heartbeat);
    runningTurns.delete(chat.id);
    send(recorder.finish({ aborted: controller.signal.aborted, started }));
    res.end();
  }
}

// ---------- turns the web page runs ----------
// The hosted page keeps API keys in the browser and runs the agent loop there
// (harness/core/loop.mjs). It starts the turn here (the selection, attachments
// and history live on this computer), runs every tool through POST /api/tool,
// and reports its events back so the chat is recorded exactly like a turn run
// here. Each answer carries the same normalized events a turn run here
// streams (plain-language steps, image and video links), so the page draws
// them the same way. There is no relay: if the page goes away mid-turn, the
// turn stops.

const PAGE_ENGINES = new Set(["anthropic", "gemini", "openai", "invite", "account"]);
const PAGE_EVENTS = new Set(["note", "tool_run", "tool_done", "final", "error", "refusal", "aborted", "timing"]);
const LEASE_MS = Number(process.env.KOMPOSIT_PAGE_LEASE_MS) || 90_000; // no word from the page for this long: it was closed

function renewLease(chatId) {
  const r = runningTurns.get(chatId);
  if (!r?.page) return;
  clearTimeout(r.page.lease);
  r.page.lease = setTimeout(() => endPageTurn(chatId, { aborted: true, reason: "page_closed" }), LEASE_MS);
  r.page.lease.unref?.();
}

// Settle a page turn (finished, stopped, or its page went away). Returns the
// "done" event, or null when no such turn is running.
function endPageTurn(chatId, { aborted = false, reason = null } = {}) {
  const r = runningTurns.get(chatId);
  if (!r?.page) return null;
  clearTimeout(r.page.lease);
  runningTurns.delete(chatId);
  markBusy(r.page.app, false);
  if (reason) r.page.turn.stopReason = reason;
  return r.page.recorder.finish({ aborted: aborted || r.page.aborted || r.controller.signal.aborted, started: r.page.started });
}

async function startPageTurn(res, body) {
  const engine = String(body.engine || "");
  if (!PAGE_ENGINES.has(engine)) return json(res, 400, { error: "unknown engine" });
  const family = body.family === "openai" ? "openai" : "anthropic"; // whose history format (see engines/index.mjs)
  const begun = beginTurn(body, engine);
  if (begun.error) return json(res, begun.status, begun.error);
  const { chat, turn, isNew, app, text, files } = begun;

  const outbox = []; // normalized events for the page, handed over with each answer
  const recorder = turnRecorder({ chat, turn, app, send: (ev) => outbox.push(ev), watchDialogs: false });
  runningTurns.set(chat.id, { controller: new AbortController(), turnId: turn.id, chat, page: { recorder, turn, app, outbox, started: Date.now(), lease: null, aborted: false } });
  renewLease(chat.id);
  markBusy(app, true);

  let userText = text;
  try {
    userText = await withContext({ app, text, files, emit: recorder.emit });
  } catch {}
  // One stored history per chat and provider family, as for turns run here.
  if (chat.apiFamily && chat.apiFamily !== family) chats.resetApiHistory(chat.id);
  chat.apiFamily = family;
  chats.saveChat(chat);
  renewLease(chat.id); // reading the selection can take seconds: the page's clock starts now

  return json(res, 200, {
    chatId: chat.id,
    turnId: turn.id,
    title: chat.title,
    isNew,
    userImages: turn.user.images.map((n) => chats.imageUrl(chat.id, n)),
    events: outbox.splice(0),
    text: userText,
    history: chats.loadApiHistory(chat.id),
    mod: platform.keys.mod,
    maxToolCalls: env.maxToolCalls,
  });
}

// The page's events for its running turn, the new tail of the model history,
// and (at the end) the outcome. Also its heartbeat: an empty call keeps the
// turn alive while the model thinks.
function recordPageTurn(res, body) {
  const r = runningTurns.get(body.chatId);
  if (!r?.page || r.turnId !== body.turnId) return json(res, 409, { error: "not_running", message: "This turn isn't running any more." });
  renewLease(body.chatId);
  const incoming = Array.isArray(body.events) ? body.events.slice(0, 500) : [];
  for (const ev of incoming) {
    if (!ev || typeof ev !== "object" || !PAGE_EVENTS.has(ev.type)) continue;
    const e = { ...ev };
    if (e.type === "tool_done") e.image = cleanImages(e.image ? [e.image] : [])[0] || null;
    if (e.type === "aborted") r.page.aborted = true;
    r.page.recorder.emit(e);
  }
  if (body.history) {
    // The history is append-only, so the page sends only what changed: the
    // messages from index `from` on.
    const from = body.history.from;
    const tail = body.history.messages;
    const stored = chats.loadApiHistory(r.chat.id);
    if (!Number.isInteger(from) || from < 0 || from > stored.length || !Array.isArray(tail)) return json(res, 400, { error: "bad history" });
    chats.saveApiHistory(r.chat.id, stored.slice(0, from).concat(tail));
  }
  const events = r.page.outbox.splice(0);
  if (body.end) {
    const done = endPageTurn(body.chatId, { aborted: body.end.status === "stopped" });
    return json(res, 200, { ok: true, ...done, events: [...events, done] });
  }
  return json(res, 200, { ok: true, events });
}

// POST /api/tool {app, name, input[, chatId, turnId]}: run one tool call on
// this computer and return its result, for the agent loop in the web page.
// The same validation, dialog notice and incident log as a turn run here.
// With Accept: text/event-stream it streams "wait" events (a dialog in the app
// is holding the step up) before the result.
async function handleTool(req, res, body) {
  const app = body.app;
  if (!APPS.includes(app)) return json(res, 400, { error: "unknown app" });
  const name = String(body.name || "");
  const input = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input : null;
  let page = null;
  if (body.chatId !== undefined) {
    page = runningTurns.get(body.chatId);
    if (!page?.page || page.turnId !== body.turnId) return json(res, 409, { error: "not_running", message: "This turn isn't running any more." });
    renewLease(body.chatId);
  }
  const stream = /text\/event-stream/.test(String(req.headers.accept || ""));
  const invalid = validateToolInput(name, input);
  if (invalid) {
    const out = { content: `INVALID_INPUT: ${invalid}. Send the call again with complete input.`, is_error: true, meta: { display: invalid } };
    if (!stream) return json(res, 200, out);
  }

  let send = () => {};
  let heartbeat = null;
  if (stream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    req.socket.setTimeout(0);
    send = (ev) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(`: keepalive\n\n`);
    }, 15000);
  }
  if (invalid) {
    send({ type: "result", content: `INVALID_INPUT: ${invalid}. Send the call again with complete input.`, is_error: true, meta: { display: invalid } });
    clearInterval(heartbeat);
    return res.end();
  }

  const stopWatch = watchForDialog(app, (text) => send({ type: "wait", text: text || null }));
  // A long step (an After Effects render) must not let the page's turn lapse.
  const keepAlive = page ? setInterval(() => renewLease(body.chatId), 20000) : null;
  if (!page) markBusy(app, true);
  let r;
  try {
    r = await executeTool(getBridge(app), name, input);
  } finally {
    stopWatch();
    clearInterval(keepAlive);
    if (!page) markBusy(app, false);
  }
  const out = { content: r.content, is_error: !!r.is_error, meta: r.meta || {} };
  if (!stream) return json(res, 200, out);
  send({ type: "result", ...out });
  clearInterval(heartbeat);
  res.end();
}

// A preview video the After Effects bridge rendered into the scratch folder:
// move it into the chat so it plays there (and survives a reload). Only that
// exact kind of file is accepted.
function previewVideo(chatId, path) {
  if (!path || typeof path !== "string") return null;
  const dir = scratchDir();
  if (dirname(path) !== dir || !/^ae_preview_\d+\.mp4$/.test(basename(path))) return null;
  try {
    const name = chats.saveImage(chatId, { media_type: "video/mp4", data: readFileSync(path).toString("base64") }, "preview");
    rmSync(path, { force: true });
    return name;
  } catch {
    return null;
  }
}

// ---------- router ----------

function makeHandler(port) {
  return async function handler(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const p = url.pathname;
    const isApi = p.startsWith("/api/");
    const isPublic = !isApi || p === "/api/hello";

    try {
      if (!guard(req, res, { port, isPublic })) return;
      res.setHeader("x-komposit-version", VERSION);

      // ----- public -----
      if (req.method === "GET" && p === "/") return serveShell(res, port);
      if (req.method === "GET" && p === "/api/hello") {
        return json(res, 200, { komposit: true, version: VERSION, port });
      }
      if (req.method === "GET" && p === "/connect") {
        // Hand the hosted UI this install's token, in the fragment (never sent
        // to any server). ?local=1 opens the copy served here instead.
        // ?return=<origin> sends the hand-over back to the hosted page that
        // asked (a preview deploy, say), as long as that origin is allowed.
        const ret = (url.searchParams.get("return") || "").replace(/\/+$/, "");
        const web = ret && webOrigins().includes(ret) ? ret : hostedUrl();
        const local = url.searchParams.get("local") === "1" || (!ret && config().uiMode === "local") || !web;
        const to = local ? `http://127.0.0.1:${port}/` : `${web}/#k=${encodeURIComponent(token())}&p=${port}`;
        res.writeHead(302, { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer" });
        return res.end();
      }
      if (!isApi) {
        if (req.method === "GET" && (await serveStatic(res, p))) return;
        return json(res, 404, { error: "not found" });
      }

      // ----- authed API -----
      if (req.method === "GET" && p === "/api/status") {
        const ai = publicAI();
        return json(res, 200, {
          version: VERSION,
          platform: process.platform,
          port,
          ai,
          onboarded: !!config().onboarded,
          efforts: Object.keys(EFFORTS),
          dataDir: DATA_DIR,
          webOrigins: webOrigins(),
          // What this app can do for the web page: run tools for it, and
          // record the turns it runs itself. `mod`: this computer's Cmd/Ctrl.
          features: ["tool", "page-turns"],
          mod: platform.keys.mod,
        });
      }

      // setup / onboarding
      if (req.method === "GET" && p === "/api/setup") {
        return json(res, 200, await setup.setupStatus({ fresh: url.searchParams.get("fresh") === "1" }));
      }
      if (req.method === "POST" && p.startsWith("/api/setup/")) {
        const body = await readBody(req);
        const action = p.slice("/api/setup/".length);
        if (action === "ai") return json(res, 200, await setup.saveAI(body));
        if (action === "ai/forget") return json(res, 200, setup.forgetAI());
        if (action === "automation") {
          if (!APPS.includes(body.app)) return json(res, 400, { error: "unknown app" });
          return json(res, 200, await setup.requestAutomation(body.app));
        }
        if (action === "launch") {
          if (!APPS.includes(body.app)) return json(res, 400, { error: "unknown app" });
          return json(res, 200, await setup.launchApp(body.app));
        }
        if (action === "files") return json(res, 200, await setup.requestFiles());
        if (action === "settings") return json(res, 200, await setup.openSettingsPane(body.pane));
        if (action === "done") return json(res, 200, setup.markOnboarded(body.done !== false));
        return json(res, 404, { error: "not found" });
      }

      if (req.method === "GET" && p === "/api/apps") {
        return json(res, 200, { apps: appManifest(), defaultApp: "illustrator" });
      }

      if (req.method === "GET" && p === "/api/workspace") {
        const snap = await workspaceSnapshot();
        // Marking files open asks each running app over AppleScript, which can
        // take seconds on a cold start. Answer with whatever is known by then.
        await Promise.race([markRecent(snap.recentFiles).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
        return json(res, 200, snap);
      }

      if (req.method === "GET" && p === "/api/thumb") {
        // Best source first: a cached real render, then render the open doc,
        // then QuickLook (blank for many .ai/.psd), then nothing.
        const path = url.searchParams.get("path") || "";
        if (!inHome(path)) return json(res, 404, { error: "not found" });
        let buf = await cachedRender(path);
        if (!buf) {
          try {
            const r = await renderOpenFile(path);
            if (r) {
              await saveRender(path, r);
              buf = r;
            }
          } catch {}
        }
        if (!buf) buf = await thumbnail(path);
        if (!buf) return json(res, 404, { error: "no preview" });
        res.writeHead(200, { "content-type": "image/png", "cache-control": "private, max-age=60" });
        return res.end(buf);
      }

      if (req.method === "GET" && p === "/api/files") {
        return json(res, 200, await browse(url.searchParams.get("dir") || ""));
      }

      if (req.method === "POST" && p === "/api/new") {
        const body = await readBody(req);
        const app = APPS.includes(body.app) ? body.app : "illustrator";
        try {
          const r = await getBridge(app).newDocument(body.opts || {});
          return json(res, 200, { ok: !!r.ok, name: r.name, app, error: r.error });
        } catch (e) {
          return json(res, 200, { ok: false, error: e.message, code: e.code || null });
        }
      }

      if (req.method === "POST" && p === "/api/open") {
        const body = await readBody(req);
        const path = String(body.path || "");
        const ok = await openFile(path);
        // Render the real artboard of the just-opened file so its card shows
        // the actual artwork.
        if (ok && APPS.includes(body.app)) {
          setTimeout(async () => {
            try {
              const r = await renderOpenFile(path);
              if (r) await saveRender(path, r);
            } catch {}
          }, 3000);
        }
        return json(res, 200, { ok });
      }

      // chats
      if (req.method === "GET" && p === "/api/chats") return json(res, 200, { chats: chats.listChats() });
      const cm = /^\/api\/chats\/(c_[a-z0-9]+)(?:\/(rename|img)(?:\/([A-Za-z0-9_.-]+))?)?$/.exec(p);
      if (cm) {
        const [, id, sub, name] = cm;
        if (!sub && req.method === "GET") {
          const c = chats.loadChat(id);
          if (!c) return json(res, 404, { error: "not found" });
          return json(res, 200, { chat: c, running: runningTurns.has(id) });
        }
        if (!sub && req.method === "DELETE") {
          const r = runningTurns.get(id);
          r?.controller.abort();
          if (r?.page) {
            clearTimeout(r.page.lease);
            runningTurns.delete(id);
            markBusy(r.page.app, false);
          }
          return json(res, 200, { ok: chats.deleteChat(id) });
        }
        if (sub === "rename" && req.method === "POST") {
          const body = await readBody(req);
          // ifTitle: rename only if the title is still that one (the page
          // naming a new chat never overrides a name the person gave it).
          if (typeof body.ifTitle === "string") {
            const cur = runningTurns.get(id)?.chat || chats.loadChat(id);
            if (cur && cur.title !== body.ifTitle) return json(res, 409, { error: "renamed", title: cur.title });
          }
          const c = chats.renameChat(id, body.title);
          const live = runningTurns.get(id)?.chat; // or the running turn would save the old title back
          if (c && live) live.title = c.title;
          return json(res, c ? 200 : 404, c ? { ok: true, title: c.title } : { error: "not found" });
        }
        if (sub === "img" && name && req.method === "GET") {
          const file = chats.imageFile(id, name);
          if (!file) return json(res, 404, { error: "not found" });
          res.writeHead(200, {
            "content-type": chats.MIME[extname(file).slice(1)] || "application/octet-stream",
            "cache-control": "private, max-age=31536000, immutable",
          });
          return createReadStream(file).pipe(res);
        }
      }

      if (req.method === "POST" && p === "/api/stop") {
        const body = await readBody(req);
        const r = runningTurns.get(body.chatId);
        if (r) r.controller.abort();
        if (r?.page) endPageTurn(body.chatId, { aborted: true });
        return json(res, 200, { ok: !!r });
      }

      if (req.method === "POST" && p === "/api/turn") {
        const body = await readBody(req);
        return handleTurn(req, res, body);
      }
      if (req.method === "POST" && p === "/api/turn/start") return startPageTurn(res, await readBody(req));
      if (req.method === "POST" && p === "/api/turn/record") return recordPageTurn(res, await readBody(req));
      if (req.method === "POST" && p === "/api/tool") {
        const body = await readBody(req);
        return handleTool(req, res, body);
      }

      return json(res, 404, { error: "not found" });
    } catch (e) {
      if (!res.headersSent) json(res, e.status || 500, { error: e.message });
      else res.end();
    }
  };
}

// ---------- start ----------

// Try the configured port, then the next few, so a second copy (or another
// app on 4321) never blocks startup. The hosted UI scans the same range.
export const PORT_RANGE = Array.from({ length: 10 }, (_, i) => 4321 + i);

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = createServer(makeHandler(port));
    server.headersTimeout = 30000;
    server.requestTimeout = 0; // turns stream for minutes
    server.keepAliveTimeout = 5000;
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function start() {
  config(); // create settings + token on first run
  await allowSlowReplies(); // a model may take minutes to start answering
  const first = Number(process.env.PORT || env.port || 4321);
  const ports = [first, ...PORT_RANGE.filter((p) => p !== first)];
  for (const port of ports) {
    try {
      await listen(port);
      const ai = effectiveAI();
      console.log(`KOMPOSIT_READY port=${port}`);
      console.log(`\n  Komposit ${VERSION} → http://127.0.0.1:${port}`);
      console.log(`  AI: ${ai.mode || "not set up yet"}${ai.source === "env" ? " (from .env)" : ""}`);
      console.log(`  data: ${DATA_DIR}\n`);
      return;
    } catch (e) {
      if (e.code !== "EADDRINUSE") throw e;
    }
  }
  console.error("No free port in 4321-4330.");
  process.exit(1);
}

// Quitting the app sends SIGTERM: stop any running turn first (that kills
// Claude Code's process group, which would otherwise keep editing), then exit.
function shutdown() {
  const busy = runningTurns.size;
  for (const [id, r] of [...runningTurns]) {
    r.controller.abort();
    if (r.page) endPageTurn(id, { aborted: true });
  }
  setTimeout(() => process.exit(0), busy ? 800 : 0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Started by Komposit.app (Mac) or the tray app (Windows): if it goes away
// without stopping us (force quit, crash), don't linger. On a Mac we're then
// re-parented to launchd; on Windows the parent process is simply gone.
if (process.env.KOMPOSIT_APP === "1") platform.watchParent(shutdown);

start();
