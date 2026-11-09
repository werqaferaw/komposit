// Komposit, the local half. A small HTTP server on 127.0.0.1 that drives the
// Adobe apps and reads design files on this computer, for one UI: either the copy
// it serves itself (http://127.0.0.1:<port>/) or the hosted UI on the web.
//
// Every /api call passes the locks in auth.mjs (host, origin, token, JSON).
// Agent turns stream back as server-sent events; each turn is also saved to
// the chat store so the conversation renders the same after a reload.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { env } from "./env.mjs";
import { config, token, effectiveAI, publicAI, DATA_DIR } from "./config.mjs";
import { guard, hostedUrl, SHELL_HEADERS, webOrigins } from "./auth.mjs";
import { appManifest, getBridge, APPS } from "./bridges/index.mjs";
import { workspaceSnapshot, thumbnail, openFile, browse, saveRender, cachedRender, inHome } from "./desktop.mjs";
import { markRecent, renderOpenFile, markBusy } from "./preview.mjs";
import * as chats from "./chats.mjs";
import * as setup from "./setup.mjs";
import { runTurnFor, EFFORTS } from "./engines/index.mjs";
import { nameChat } from "./titles.mjs";
import { watchForDialog } from "./dialogwatch.mjs";
import { scratchDir } from "./scratch.mjs";
import platform from "./platform/index.mjs";
import { stepLabel, doneLabel, cleanToolName } from "./labels.mjs";

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

async function handleTurn(req, res, body) {
  const ai = effectiveAI();
  if (!ai.mode) return json(res, 409, { error: "setup_required", message: "Choose an AI in Settings first." });

  const app = APPS.includes(body.app) ? body.app : "illustrator";
  const text = String(body.text || "").trim();
  const images = cleanImages(body.images);
  const incoming = cleanFiles(body.files);
  const effort = EFFORTS[body.effort] ? body.effort : "medium";
  if (!text && !images.length && !incoming.length) return json(res, 400, { error: "empty message" });

  let chat = body.chatId ? chats.loadChat(body.chatId) : null;
  const isNew = !chat;
  if (!chat) chat = chats.createChat({ app, title: chats.titleFrom(text || incoming[0]?.name || "") });
  if (runningTurns.has(chat.id)) return json(res, 409, { error: "busy", message: "This chat is still working." });

  const turn = {
    id: "t_" + randomBytes(5).toString("hex"),
    at: Date.now(),
    app,
    effort,
    engine: ai.mode,
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
  const stepStart = new Map(); // tool id -> t0
  const stepInput = new Map();
  let lastSave = 0;
  const persist = (force = false) => {
    if (force || Date.now() - lastSave > 1500) {
      lastSave = Date.now();
      chats.saveChat(chat);
    }
  };

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

  const watchers = new Map(); // step id -> stop() for its dialog watcher

  // Every engine event passes through here: recorded on the turn, then sent
  // to the UI in one normalized, plain-language shape.
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
        watchers.set(
          ev.id,
          watchForDialog(app, (text) => {
            if (step.status !== "running") return;
            step.waiting = text || undefined;
            send({ type: "step_wait", id: ev.id, text: text || null });
          }),
        );
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

  markBusy(app, true);
  try {
    await runTurnFor(ai, { chat, turn, app, text, images, files, effort, emit, signal: controller.signal });
  } catch (e) {
    if (!controller.signal.aborted) emit({ type: "error", message: e.message });
  } finally {
    markBusy(app, false);
    clearInterval(heartbeat);
    for (const stop of watchers.values()) stop();
    watchers.clear();
    runningTurns.delete(chat.id);
    turn.durationMs = Date.now() - started;
    if (controller.signal.aborted) turn.status = "stopped";
    else if (turn.error) turn.status = "error";
    else turn.status = "done";
    // Steps still marked running when a turn ends were cut off.
    for (const s of turn.steps) if (s.status === "running") s.status = turn.status === "stopped" ? "stopped" : "error";
    chats.saveChat(chat);
    send({ type: "done", status: turn.status, durationMs: turn.durationMs, chatId: chat.id, turnId: turn.id });
    res.end();
  }
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
          runningTurns.get(id)?.controller.abort();
          return json(res, 200, { ok: chats.deleteChat(id) });
        }
        if (sub === "rename" && req.method === "POST") {
          const body = await readBody(req);
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
        return json(res, 200, { ok: !!r });
      }

      if (req.method === "POST" && p === "/api/turn") {
        const body = await readBody(req);
        return handleTurn(req, res, body);
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
  for (const r of runningTurns.values()) r.controller.abort();
  setTimeout(() => process.exit(0), runningTurns.size ? 800 : 0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Started by Komposit.app (Mac) or the tray app (Windows): if it goes away
// without stopping us (force quit, crash), don't linger. On a Mac we're then
// re-parented to launchd; on Windows the parent process is simply gone.
if (process.env.KOMPOSIT_APP === "1") platform.watchParent(shutdown);

start();
