// Chat history, kept on the tester's Mac so conversations survive a reload or
// a restart and render the same way every time.
//
//   <data>/chats/<id>/chat.json   what the UI shows: turns, steps, results
//   <data>/chats/<id>/api.json    the API engine's message history (append-only)
//   <data>/chats/<id>/img/<n>     renders and reference images, served by URL
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  readdirSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "./config.mjs";

const CHATS = join(DATA_DIR, "chats");
const ID_RE = /^c_[a-z0-9]{6,40}$/;
const IMG_RE = /^[a-z0-9_-]{1,64}\.(png|jpg|jpeg|webp|gif|mp4)$/;
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4" };
export const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", mp4: "video/mp4" };

export function newChatId() {
  return "c_" + randomBytes(10).toString("hex");
}

export function validChatId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

function dir(id) {
  return join(CHATS, id);
}

function writeJson(path, obj) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function listChats() {
  let ids = [];
  try {
    ids = readdirSync(CHATS).filter((n) => ID_RE.test(n));
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    const c = readJson(join(dir(id), "chat.json"));
    if (!c) continue;
    out.push({
      id: c.id,
      title: c.title || "Untitled",
      app: c.app,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      turns: (c.turns || []).length,
    });
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function loadChat(id) {
  if (!validChatId(id)) return null;
  return readJson(join(dir(id), "chat.json"));
}

export function createChat({ id = newChatId(), app = "illustrator", title = "" } = {}) {
  if (!validChatId(id)) id = newChatId();
  mkdirSync(join(dir(id), "img"), { recursive: true, mode: 0o700 });
  const now = Date.now();
  const chat = { id, title, app, createdAt: now, updatedAt: now, turns: [], cli: {} };
  writeJson(join(dir(id), "chat.json"), chat);
  return chat;
}

export function saveChat(chat) {
  if (!validChatId(chat?.id)) return;
  mkdirSync(join(dir(chat.id), "img"), { recursive: true, mode: 0o700 });
  chat.updatedAt = Date.now();
  writeJson(join(dir(chat.id), "chat.json"), chat);
}

export function renameChat(id, title) {
  const c = loadChat(id);
  if (!c) return null;
  c.title = String(title || "").slice(0, 120);
  saveChat(c);
  return c;
}

export function deleteChat(id) {
  if (!validChatId(id)) return false;
  try {
    rmSync(dir(id), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// Store an image ({media_type, data(base64)} or a Buffer) and return its name.
export function saveImage(id, img, prefix = "img") {
  if (!validChatId(id) || !img) return null;
  const buf = Buffer.isBuffer(img) ? img : Buffer.from(img.data || "", "base64");
  if (!buf.length) return null;
  const ext = Buffer.isBuffer(img) ? "png" : EXT[img.media_type] || "png";
  const name = `${prefix}-${Date.now().toString(36)}${randomBytes(3).toString("hex")}.${ext}`;
  mkdirSync(join(dir(id), "img"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir(id), "img", name), buf, { mode: 0o600 });
  return name;
}

// Store an attached file (any type) under the chat's files/ folder, keeping a
// readable, safe, unique name. Returns { name, path, size } or null.
export function saveFile(id, file) {
  if (!validChatId(id) || !file || typeof file.data !== "string") return null;
  const buf = Buffer.from(file.data, "base64");
  if (!buf.length) return null;
  const raw = String(file.name || "file").split(/[\\/]/).pop();
  const clean = raw.replace(/[\u0000-\u001f:*?"<>|]+/g, "-").replace(/^\.+/, "").slice(0, 120) || "file";
  const folder = join(dir(id), "files");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const dot = clean.lastIndexOf(".");
  const base = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  let name = clean;
  for (let n = 2; existsSync(join(folder, name)); n++) name = `${base} ${n}${ext}`;
  const path = join(folder, name);
  writeFileSync(path, buf, { mode: 0o600 });
  return { name, path, size: buf.length };
}

export function filesDir(id) {
  return validChatId(id) ? join(dir(id), "files") : null;
}

export function imageFile(id, name) {
  if (!validChatId(id) || !IMG_RE.test(String(name))) return null;
  const p = join(dir(id), "img", name);
  try {
    return statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

export function imageUrl(id, name) {
  return name ? `/api/chats/${id}/img/${name}` : null;
}

// The API engine's conversation. Append-only: earlier messages (thinking
// blocks included) are sent back exactly as received.
export function loadApiHistory(id) {
  if (!validChatId(id)) return [];
  return readJson(join(dir(id), "api.json")) || [];
}

export function saveApiHistory(id, messages) {
  if (!validChatId(id)) return;
  mkdirSync(dir(id), { recursive: true, mode: 0o700 });
  writeJson(join(dir(id), "api.json"), messages);
}

export function resetApiHistory(id) {
  if (!validChatId(id)) return;
  const p = join(dir(id), "api.json");
  if (existsSync(p)) rmSync(p, { force: true });
}

// A short title from the first message.
export function titleFrom(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "Reference image";
  return t.length > 60 ? t.slice(0, 57).replace(/\s+\S*$/, "") + "…" : t;
}
