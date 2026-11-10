// Which web pages may use the gateway from a browser, and the CORS headers they get.
//
// One list serves two purposes: the origins a sign-in may return to (the
// session travels there in a URL fragment) and the origins allowed to call
// /v1/messages, /v1/me, /auth/logout and /health from a browser. It is RETURN_ORIGINS
// (default https://app.komposit.werq.dev) plus the Komposit app's own local
// page, which runs on the first free port in 4321-4330.
//
// Requests without an Origin header (server-to-server, like the app's local
// Node server) are not affected: they never get, or need, CORS headers.
import { splitList } from "./util.js";

const DEFAULT_RETURN_ORIGINS = "https://app.komposit.werq.dev";
const LOCAL_PAGE_ORIGINS = Array.from({ length: 10 }, (_, i) => 4321 + i).flatMap((port) => [
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
]);

/** Routes a browser may call, and the methods it may use on each. The hosted
 * page reads /health to know whether to offer sign-in and invites. */
export const CORS_ROUTES = {
  "/v1/messages": ["POST"],
  "/v1/me": ["GET", "DELETE"],
  "/auth/logout": ["POST"],
  "/health": ["GET"],
};

// The headers the Anthropic SDK reads from responses (content-type is always readable).
const EXPOSED_HEADERS = "request-id, retry-after, retry-after-ms, x-should-retry";
// Chromium caps a cached preflight at 2 hours; Firefox at 24.
const PREFLIGHT_MAX_AGE = "7200";
const HEADER_LIST = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+(?:[ \t]*,[ \t]*[A-Za-z0-9!#$%&'*+.^_`|~-]+)*$/;

let cachedSource;
let cachedOrigins;

export function allowedOrigins(env) {
  const source = String(env.RETURN_ORIGINS ?? DEFAULT_RETURN_ORIGINS);
  if (source !== cachedSource) {
    const configured = splitList(source).map(originOf).filter(Boolean);
    cachedOrigins = new Set([...configured, ...LOCAL_PAGE_ORIGINS]);
    cachedSource = source;
  }
  return cachedOrigins;
}

export function isAllowedOrigin(origin, env) {
  return typeof origin === "string" && allowedOrigins(env).has(origin);
}

/**
 * The `return` parameter of a sign-in, if it is exactly an allowed origin
 * (scheme, host and port; no path, query, fragment or user info). Otherwise null.
 */
export function parseReturnOrigin(value, env) {
  if (typeof value !== "string" || value.length > 200) return null;
  const origin = originOf(value);
  if (!origin || value.replace(/\/$/, "") !== origin) return null;
  return isAllowedOrigin(origin, env) ? origin : null;
}

/** A 204 preflight answer for an allowed origin and method, or null (the caller answers 404, with no CORS headers). */
export function preflight(request, env, methods) {
  const origin = request.headers.get("origin");
  const method = (request.headers.get("access-control-request-method") || "").toUpperCase();
  if (!isAllowedOrigin(origin, env) || !methods.includes(method)) return null;
  const headers = new Headers({
    "access-control-allow-origin": origin,
    "access-control-allow-methods": methods.join(", "),
    "access-control-max-age": PREFLIGHT_MAX_AGE,
    vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  });
  // Echo the requested headers: the "*" wildcard never covers Authorization,
  // and the browser SDK sends many (x-api-key or authorization, anthropic-*,
  // x-stainless-*). Echoing is safe because the gateway builds its upstream
  // headers from scratch and ignores everything else.
  const requested = (request.headers.get("access-control-request-headers") || "").trim();
  if (requested && requested.length <= 2048 && HEADER_LIST.test(requested)) {
    headers.set("access-control-allow-headers", requested);
  }
  return new Response(null, { status: 204, headers });
}

/** Add CORS headers to a response for an allowed Origin. Other origins, and no Origin, get none. */
export function withCors(response, request, env) {
  const origin = request.headers.get("origin");
  let res = response;
  const set = (name, value) => {
    try {
      res.headers.set(name, value);
    } catch {
      res = new Response(res.body, res); // immutable headers (a fetched response): copy once
      res.headers.set(name, value);
    }
  };
  if (origin !== null) set("vary", "Origin");
  if (isAllowedOrigin(origin, env)) {
    set("access-control-allow-origin", origin);
    set("access-control-expose-headers", EXPOSED_HEADERS);
  }
  return res;
}

function originOf(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}
