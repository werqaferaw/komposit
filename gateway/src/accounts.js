// Optional sign-in with Google, and the accounts and sessions it creates.
//
// Signing in is never required: invites and everything in the app work without
// it. An account is for what only an account can do; today that is using an
// allowance the owner granted (scripts/grant.mjs) without an invite code.
//
// Routes (wired in index.js)
//   GET  /auth/google/start?return=<origin>   302 to Google's consent screen
//   GET  /auth/google/callback?code&state     302 to <origin>/#ks=<session>, or <origin>/#ks_error=<code>
//   POST /auth/logout                         ends the session sent in x-api-key / Authorization; 204
//
// The flow is OAuth 2.0 authorization code with PKCE (S256), state and nonce.
// One-time state lives in D1 (oauth_states, 10 minutes): the callback deletes
// the row as it reads it, so a state works once, and the PKCE verifier and the
// nonce never leave the server. The same state also goes into a short-lived
// HttpOnly cookie scoped to /auth/google/, and the callback requires the two to
// match. That ties the callback to the browser that started the sign-in, so
// nobody can sign someone else in to the attacker's account (login CSRF) by
// sending them a callback link.
//
// A session is "ks_" + 52 random base32 characters (260 bits). The person's
// browser gets it once, in a URL fragment (never sent to any server); D1 keeps
// only its SHA-256, for 30 days.
//
// Stored per account: Google's subject id, the verified email, the display
// name, the creation time and the allowance. Nothing else from Google is kept;
// the access token Google returns is never used or stored.
import { isAllowedOrigin, parseReturnOrigin } from "./cors.js";
import {
  apiError,
  base64url,
  base64urlDecodeText,
  errorSummary,
  log,
  nonNegativeInt,
  parseJson,
  randomBase32,
  randomBase64url,
  sameString,
  sha256,
  sha256Hex,
} from "./util.js";

export const SESSION_PREFIX = "ks_";
const SESSION_PATTERN = /^ks_[a-z2-7]{52}$/;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_TTL_SECONDS = 10 * 60;
const CLOCK_SKEW_SECONDS = 120;
const TOKEN_TIMEOUT_MS = 15_000;
const SCOPE = "openid email profile";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const GOOGLE_DEFAULTS = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
};

/**
 * Whether sign-in can run, and what it needs. GOOGLE_CLIENT_ID still set to the
 * wrangler.toml placeholder (anything starting with "TODO") counts as missing,
 * so a deploy before the owner has a Google client simply has sign-in off.
 */
export function signInConfig(env) {
  const clientId = String(env.GOOGLE_CLIENT_ID ?? "").trim();
  const authUrl = endpointUrl(env.GOOGLE_AUTH_URL, GOOGLE_DEFAULTS.authUrl);
  const tokenUrl = endpointUrl(env.GOOGLE_TOKEN_URL, GOOGLE_DEFAULTS.tokenUrl);
  const missing = [];
  if (!clientId || /^TODO/i.test(clientId)) missing.push("GOOGLE_CLIENT_ID");
  if (!env.GOOGLE_CLIENT_SECRET) missing.push("GOOGLE_CLIENT_SECRET");
  if (!env.DB) missing.push("DB");
  if (!authUrl) missing.push("GOOGLE_AUTH_URL");
  if (!tokenUrl) missing.push("GOOGLE_TOKEN_URL");
  return { ready: missing.length === 0, missing, clientId, clientSecret: env.GOOGLE_CLIENT_SECRET, authUrl, tokenUrl };
}

// ---------------------------------------------------------------------------
// GET /auth/google/start?return=<origin>

export async function handleGoogleStart(request, env, ctx, url) {
  const returnOrigin = parseReturnOrigin(url.searchParams.get("return"), env);
  if (!returnOrigin) {
    log("warn", { evt: "sign_in_refused", reason: "return_origin" });
    return errorPage(400, "This sign-in link didn't come from Komposit. Open Komposit and sign in from there.");
  }
  const config = signInConfig(env);
  if (!config.ready) {
    log("warn", { evt: "sign_in_unavailable", missing: config.missing });
    return backToApp(returnOrigin, { ks_error: "unavailable" });
  }

  const state = randomBase64url(32);
  const nonce = randomBase64url(32);
  const verifier = randomBase64url(32); // 43 characters, within PKCE's 43-128
  const now = Date.now();
  try {
    await env.DB.prepare(
      "INSERT INTO oauth_states (state_hash, code_verifier, nonce, return_origin, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
      .bind(await sha256Hex(state), verifier, nonce, returnOrigin, iso(now), iso(now + STATE_TTL_SECONDS * 1000))
      .run();
  } catch (err) {
    log("error", { evt: "d1_failed", step: "sign_in_start", error: errorSummary(err) });
    return backToApp(returnOrigin, { ks_error: "unavailable" });
  }
  ctx.waitUntil(sweepExpired(env.DB, "oauth_states", now));

  const google = new URL(config.authUrl);
  const params = {
    client_id: config.clientId,
    redirect_uri: callbackUrl(url),
    response_type: "code",
    scope: SCOPE,
    state,
    nonce,
    code_challenge: base64url(await sha256(verifier)),
    code_challenge_method: "S256",
    prompt: "select_account",
  };
  for (const [name, value] of Object.entries(params)) google.searchParams.set(name, value);
  return redirect(google.toString(), { "set-cookie": stateCookie(url, state, STATE_TTL_SECONDS) });
}

// ---------------------------------------------------------------------------
// GET /auth/google/callback?code&state   (or ?error=access_denied&state when the person cancels)

export async function handleGoogleCallback(request, env, ctx, url) {
  const config = signInConfig(env);
  if (!config.ready) {
    log("warn", { evt: "sign_in_unavailable", missing: config.missing });
    return errorPage(503, "Sign-in isn't available right now. Go back to Komposit; everything else works without it.");
  }
  const clearCookie = { "set-cookie": stateCookie(url, "", 0) };

  const state = url.searchParams.get("state") || "";
  let pending = null;
  if (state && state.length <= 128) {
    try {
      // Deleting the row as it is read is what makes a state work only once.
      pending = await env.DB.prepare(
        "DELETE FROM oauth_states WHERE state_hash = ?1 RETURNING code_verifier, nonce, return_origin, expires_at",
      )
        .bind(await sha256Hex(state))
        .first();
    } catch (err) {
      log("error", { evt: "d1_failed", step: "sign_in_state", error: errorSummary(err) });
      return errorPage(503, "Sign-in isn't available right now. Go back to Komposit and try again in a minute.", clearCookie);
    }
  }
  if (!pending) {
    // Unknown, already used, or swept after expiring: no return origin to go back to.
    log("warn", { evt: "sign_in_failed", reason: "unknown_state" });
    return errorPage(400, "This sign-in link has expired or was already used. Go back to Komposit and sign in again.", clearCookie);
  }
  if (!isAllowedOrigin(pending.return_origin, env)) {
    // RETURN_ORIGINS changed since this sign-in started: never send a session to an origin no longer trusted.
    log("warn", { evt: "sign_in_failed", reason: "return_origin_removed" });
    return errorPage(400, "This sign-in link didn't come from Komposit. Open Komposit and sign in from there.", clearCookie);
  }
  const fail = (code, reason, extra = {}) => {
    log("warn", { evt: "sign_in_failed", reason, ...extra });
    return backToApp(pending.return_origin, { ks_error: code }, clearCookie);
  };

  const now = Date.now();
  if (!(pending.expires_at > iso(now))) return fail("expired", "state_expired");
  if (!sameString(readCookie(request, stateCookieName(url)), state)) return fail("state", "state_cookie");
  const googleError = url.searchParams.get("error");
  if (googleError) {
    return fail(googleError === "access_denied" ? "cancelled" : "google", "google_error", { error: errorCode(googleError) });
  }
  const code = url.searchParams.get("code");
  if (!code || code.length > 2048) return fail("google", "code_missing");

  let tokens;
  try {
    const res = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl(url),
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code_verifier: pending.code_verifier,
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    tokens = parseJson(await res.text());
    if (!res.ok) {
      // Google's error code (e.g. invalid_grant) is safe to log; its description is left out.
      return fail("token", "token_exchange", { status: res.status, error: errorCode(tokens?.error) });
    }
  } catch (err) {
    return fail("token", "token_unreachable", { error: errorSummary(err) });
  }

  const identity = readIdToken(tokens?.id_token, { clientId: config.clientId, nonce: pending.nonce, now });
  if (identity.error) return fail("id_token", `id_token_${identity.error}`);

  let account;
  const session = SESSION_PREFIX + randomBase32(52);
  try {
    account = await findOrCreateAccount(env.DB, identity, iso(now));
    await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)")
      .bind(await sha256Hex(session), account.id, iso(now), iso(now + SESSION_TTL_MS))
      .run();
  } catch (err) {
    log("error", { evt: "d1_failed", step: "sign_in_account", error: errorSummary(err) });
    return backToApp(pending.return_origin, { ks_error: "server" }, clearCookie);
  }
  ctx.waitUntil(sweepExpired(env.DB, "sessions", now));
  log("info", { evt: "sign_in", outcome: account.outcome, account: account.id });
  return backToApp(pending.return_origin, { ks: session }, clearCookie);
}

/**
 * The identity in an id_token taken straight from Google's token endpoint, or { error }.
 *
 * The JWT signature is not verified. OpenID Connect Core 3.1.3.7 allows that
 * for an id_token received directly from the token endpoint over TLS: the TLS
 * connection authenticates the issuer. GOOGLE_TOKEN_URL must therefore be
 * https (endpointUrl allows plain http only to this machine, for the tests).
 * Every claim that matters is checked: iss, aud (and azp), exp, nonce, sub.
 * The email is kept only if Google says it is verified.
 */
export function readIdToken(idToken, { clientId, nonce, now = Date.now() }) {
  if (typeof idToken !== "string" || idToken.length > 16384) return { error: "missing" };
  const parts = idToken.split(".");
  if (parts.length !== 3) return { error: "malformed" };
  let claims;
  try {
    claims = JSON.parse(base64urlDecodeText(parts[1]));
  } catch {
    return { error: "malformed" };
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return { error: "malformed" };
  if (!GOOGLE_ISSUERS.has(claims.iss)) return { error: "iss" };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(clientId)) return { error: "aud" };
  if ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== clientId) return { error: "azp" };
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS <= now / 1000) return { error: "exp" };
  if (!sameString(claims.nonce, nonce)) return { error: "nonce" };
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) return { error: "sub" };

  const verified = claims.email_verified === true || claims.email_verified === "true";
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  const name = typeof claims.name === "string" ? claims.name.trim().slice(0, 200) : "";
  return { sub: claims.sub, email: verified && email && email.length <= 254 ? email : null, name: name || null };
}

/** Find the account for a Google identity, claim the owner's pre-grant for its email, or create one. */
async function findOrCreateAccount(db, { sub, email, name }, nowIso) {
  for (let attempt = 1; ; attempt++) {
    try {
      // 1. Someone who has signed in before. Keep the name and the verified email current.
      const known = await db
        .prepare("UPDATE users SET name = ?2, email = COALESCE(?3, email) WHERE google_sub = ?1 RETURNING id")
        .bind(sub, name, email)
        .first();
      if (known) return { id: known.id, outcome: "returning" };

      // 2. A row the owner pre-granted by email, claimed only with an email Google verified.
      if (email) {
        const claimed = await db
          .prepare(
            "UPDATE users SET google_sub = ?1, name = ?2 WHERE id = (SELECT id FROM users WHERE google_sub IS NULL AND email = ?3 ORDER BY id LIMIT 1) RETURNING id",
          )
          .bind(sub, name, email)
          .first();
        if (claimed) return { id: claimed.id, outcome: "claimed" };
      }

      // 3. Someone new: an account with no allowance until the owner grants one.
      const created = await db
        .prepare("INSERT INTO users (google_sub, email, name, created_at, allowance) VALUES (?1, ?2, ?3, ?4, 0) RETURNING id")
        .bind(sub, email, name, nowIso)
        .first();
      return { id: created.id, outcome: "created" };
    } catch (err) {
      // Two first sign-ins by the same person at once: the second hits the
      // unique google_sub, and the next round finds the first one's row.
      if (attempt >= 2 || !/UNIQUE/i.test(String(err?.message))) throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Sessions

/** The account behind a "ks_" session token: { account } or { error } (a Response). */
export async function authenticateSession(token, env, ctx) {
  if (!env.DB || !SESSION_PATTERN.test(token)) {
    log("warn", { evt: "auth_failed", reason: env.DB ? "malformed_session" : "sign_in_not_configured" });
    return { error: sessionError() };
  }
  const hash = await sha256Hex(token);
  let row;
  try {
    row = await env.DB.prepare(
      "SELECT u.id, u.email, u.name, u.allowance, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1",
    )
      .bind(hash)
      .first();
  } catch (err) {
    log("error", { evt: "d1_failed", step: "session", error: errorSummary(err) });
    return { error: apiError(503, "api_error", "The gateway's storage is temporarily unavailable") };
  }
  if (!row) {
    log("warn", { evt: "auth_failed", reason: "unknown_session" });
    return { error: sessionError() };
  }
  if (!(row.expires_at > new Date().toISOString())) {
    log("warn", { evt: "auth_failed", reason: "expired_session", account: row.id });
    ctx.waitUntil(
      env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(hash).run().catch(() => {}),
    );
    return { error: sessionError() };
  }
  return {
    account: {
      id: row.id,
      email: row.email ?? null,
      name: row.name ?? null,
      allowance: nonNegativeInt(row.allowance) ?? 0,
      sessionExpiresAt: row.expires_at,
    },
  };
}

function sessionError() {
  return apiError(401, "authentication_error", "This sign-in is no longer valid. Sign in again.");
}

/** POST /auth/logout: delete the session in the request's x-api-key / Authorization header. */
export async function handleLogout(token, env) {
  if (!token || !token.startsWith(SESSION_PREFIX)) {
    log("warn", { evt: "auth_failed", reason: "logout_without_session" });
    return apiError(401, "authentication_error", "Sign out needs the session in the x-api-key or Authorization header.");
  }
  let ended = null;
  if (env.DB && SESSION_PATTERN.test(token)) {
    try {
      ended = await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?1 RETURNING user_id")
        .bind(await sha256Hex(token))
        .first();
    } catch (err) {
      log("error", { evt: "d1_failed", step: "logout", error: errorSummary(err) });
      return apiError(503, "api_error", "The gateway's storage is temporarily unavailable");
    }
  }
  // 204 even for a session that had already ended: signing out twice is fine.
  log("info", { evt: "sign_out", ...(ended ? { account: ended.user_id } : { known: false }) });
  return new Response(null, { status: 204 });
}

/** Delete an account and all its sessions from D1. The caller deletes its usage counters in KV. */
export async function deleteAccountRecords(db, accountId) {
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(accountId),
    db.prepare("DELETE FROM users WHERE id = ?1").bind(accountId),
  ]);
}

// ---------------------------------------------------------------------------
// Helpers

/** Remove expired rows. `table` is one of two constants, never input. */
async function sweepExpired(db, table, now) {
  try {
    await db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?1`).bind(iso(now)).run();
  } catch (err) {
    log("warn", { evt: "d1_sweep_failed", table, error: errorSummary(err) });
  }
}

/** An https URL, or plain http only to this machine (the tests' mock Google). Otherwise null. */
function endpointUrl(value, fallback) {
  try {
    const url = new URL(String(value ?? "").trim() || fallback);
    if (url.protocol === "https:") return url.toString();
    if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return url.toString();
  } catch {
    // fall through
  }
  return null;
}

function callbackUrl(url) {
  return `${url.origin}/auth/google/callback`;
}

// __Secure- keeps a plain-http response (or a network attacker) from planting
// the cookie. Local development runs on http://localhost, which can't use it.
function stateCookieName(url) {
  return url.protocol === "https:" ? "__Secure-ks_state" : "ks_state";
}

function stateCookie(url, value, maxAge) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${stateCookieName(url)}=${value}; Max-Age=${maxAge}; Path=/auth/google/; HttpOnly; SameSite=Lax${secure}`;
}

function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer", ...extraHeaders },
  });
}

/** Back to the page that started the sign-in, with the result in the fragment (never sent to a server). */
function backToApp(origin, params, extraHeaders) {
  return redirect(`${origin}/#${new URLSearchParams(params)}`, extraHeaders);
}

function errorPage(status, message, extraHeaders = {}) {
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Komposit sign-in</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 16px;color:#1c1c1c;background:#fff}
@media (prefers-color-scheme:dark){body{color:#ececec;background:#161616}}h1{font-size:1.25rem;margin:0 0 .5rem}</style>
<h1>Sign-in didn't work</h1>
<p>${escapeHtml(message)}</p>
</html>
`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      ...extraHeaders,
    },
  });
}

/** An OAuth error code fit for the logs (they look like "invalid_grant"); anything else is "other". */
function errorCode(value) {
  return typeof value === "string" && /^[a-z_]{1,64}$/.test(value) ? value : "other";
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function iso(ms) {
  return new Date(ms).toISOString();
}
