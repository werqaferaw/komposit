// Who may talk to the local server. It can drive Adobe apps and read files, so
// only Komposit's own UI gets in. Four cheap locks:
//
//  1. Host check. The Host header must be 127.0.0.1/localhost:<port>. A page on
//     evil.com that re-points its DNS at 127.0.0.1 (DNS rebinding) still sends
//     Host: evil.com, so it is refused.
//  2. Origin allowlist. Browsers always send Origin on cross-origin requests
//     and pages cannot forge it. Only the local UI and the hosted UI pass.
//  3. Per-install token. Every /api call carries `Authorization: Bearer <t>`.
//     The local UI gets the token inlined in its HTML (other origins cannot
//     read that page); the hosted UI gets it once through a URL fragment
//     handed over by /connect (fragments are never sent to any server).
//  4. JSON-only writes. POST/PUT/DELETE must be application/json, so a plain
//     <form> or a text/plain beacon cannot trigger anything.
//
// Plus the CORS and Private Network Access headers the hosted UI needs.
import { timingSafeEqual } from "node:crypto";
import { config, token } from "./config.mjs";

// Hosted UI origins allowed to call in. Extra ones (a preview deploy, a test
// tunnel) come from KOMPOSIT_WEB_ORIGINS or config.webOrigins.
export const DEFAULT_WEB_ORIGINS = ["https://app.komposit.werq.dev"];

export function webOrigins() {
  const fromEnv = (process.env.KOMPOSIT_WEB_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const fromCfg = Array.isArray(config().webOrigins) ? config().webOrigins : [];
  return [...new Set([...DEFAULT_WEB_ORIGINS, ...fromCfg, ...fromEnv])];
}

// The hosted UI that /connect hands the token to.
export function hostedUrl() {
  return (process.env.KOMPOSIT_WEB_URL || config().webUrl || DEFAULT_WEB_ORIGINS[0]).replace(/\/+$/, "");
}

export function localOrigins(port) {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

function hostOk(req, port) {
  const h = String(req.headers.host || "").toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

function tokenOk(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ""));
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(token());
  return a.length === b.length && timingSafeEqual(a, b);
}

function deny(res, code, error) {
  if (!res.headersSent) {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  }
  res.end(JSON.stringify({ error }));
  return false;
}

// Run the locks for one request. Returns true when the handler may proceed;
// otherwise the response has already been sent.
//   isPublic: no token needed (the UI shell, static assets, /api/hello, /connect)
export function guard(req, res, { port, isPublic = false }) {
  if (!hostOk(req, port)) return deny(res, 421, "wrong host");

  const origin = req.headers.origin;
  const allowed = new Set([...localOrigins(port), ...webOrigins()]);
  const originAllowed = !!origin && allowed.has(origin);
  if (origin && !originAllowed) return deny(res, 403, "origin not allowed");

  if (originAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Expose-Headers", "x-komposit-version");
  }

  if (req.method === "OPTIONS") {
    // CORS preflight. The Private Network Access header lets an https page
    // reach this loopback server in Chromium browsers.
    if (!originAllowed) return deny(res, 403, "origin not allowed");
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Private-Network": "true",
      "Access-Control-Max-Age": "600",
    });
    res.end();
    return false;
  }

  if (isPublic) return true;

  if (!tokenOk(req)) return deny(res, 401, "not paired");

  if (req.method !== "GET" && req.method !== "HEAD") {
    const ct = String(req.headers["content-type"] || "").toLowerCase();
    if (!ct.startsWith("application/json")) return deny(res, 415, "json only");
  }
  return true;
}

// Headers for the HTML shell: never framed, never cached, no referrer leaks.
export const SHELL_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
