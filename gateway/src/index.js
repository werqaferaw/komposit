/**
 * komposit-gateway: lets invited Komposit testers use the owner's Anthropic API
 * key without the key ever leaving this Worker.
 *
 * Testers point the official Anthropic SDK at the gateway and use an invite code
 * as their API key:
 *
 *   new Anthropic({ baseURL: "https://gateway.komposit.werq.dev", apiKey: "kp_..." })
 *
 * Routes
 *   POST /v1/messages  check the invite and its limits, forward to Anthropic with
 *                      the owner key, stream the response back, meter token usage
 *   GET  /v1/me        { name, limits, usage } for the calling invite
 *   GET  /health       liveness and configuration check
 *
 * Storage (Workers KV, soft limits: KV is eventually consistent)
 *   INVITES  inv:<sha256 hex of code>  {"name", "disabled"?, "dailyRequests"?, "monthlyOutputTokens"?, "models"?}
 *   USAGE    req:<hash>:<YYYY-MM-DD>   requests counted that UTC day
 *            tok:<hash>:<YYYY-MM>      {"output_tokens", "input_tokens", "cache_creation_input_tokens",
 *                                       "cache_read_input_tokens", "updated_at"} for that UTC month
 *
 * Never logs request or response bodies, invite codes, or keys.
 */

const DEFAULTS = {
  UPSTREAM_BASE: "https://api.anthropic.com",
  ALLOWED_MODELS: "claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5",
  MAX_TOKENS_CAP: 64000,
  DEFAULT_DAILY_REQUESTS: 300,
  DEFAULT_MONTHLY_OUTPUT_TOKENS: 2_000_000,
};

const MAX_REQUEST_BYTES = 32 * 1024 * 1024; // the Messages API's own request size limit
const MAX_CODE_LENGTH = 256;
const DAY_COUNTER_TTL = 8 * 24 * 60 * 60; // seconds
const MONTH_COUNTER_TTL = 400 * 24 * 60 * 60; // keep about 13 months of monthly usage
const KV_WRITE_ATTEMPTS = 3; // KV accepts about one write per second to the same key

// Upstream response headers the client gets back. Everything else stays in the
// Worker, notably anthropic-organization-id and the anthropic-ratelimit-* headers,
// which describe the owner's account.
const PASSTHROUGH_RESPONSE_HEADERS = ["content-type", "request-id", "retry-after", "retry-after-ms", "x-should-retry"];

const USAGE_FIELDS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      switch (`${request.method} ${url.pathname}`) {
        case "POST /v1/messages":
          return await handleMessages(request, env, ctx, url);
        case "GET /v1/me":
          return await handleMe(request, env);
        case "GET /health":
          return handleHealth(env);
        default:
          return apiError(404, "not_found_error", "Not found");
      }
    } catch (err) {
      log("error", { evt: "unhandled", path: url.pathname, error: errorSummary(err) });
      return apiError(500, "api_error", "Internal gateway error");
    }
  },
};

// ---------------------------------------------------------------------------
// POST /v1/messages

async function handleMessages(request, env, ctx, url) {
  const started = Date.now();
  const auth = await authenticate(request, env);
  if (auth.error) return auth.error;
  const { hash, invite } = auth;
  const name = inviteName(invite);

  if (!env.ANTHROPIC_API_KEY) {
    log("error", { evt: "misconfigured", missing: "ANTHROPIC_API_KEY" });
    return apiError(500, "api_error", "The gateway is not configured yet");
  }

  const limits = resolveLimits(invite, env);
  const period = currentPeriod();
  const requestsKey = `req:${hash}:${period.day}`;
  const tokensKey = `tok:${hash}:${period.month}`;
  const [requestsToday, monthUsage] = await Promise.all([
    readCount(env.USAGE, requestsKey),
    readUsage(env.USAGE, tokensKey),
  ]);

  // The messages name the invite and the limit: the Komposit app shows a 429's
  // message to the person only when it mentions one of those words.
  if (requestsToday >= limits.dailyRequests) {
    log("warn", { evt: "rejected", reason: "daily_requests", invite: name });
    return limitError(
      `This invite's daily request limit is used up (${formatInt(limits.dailyRequests)} requests per day). It resets at 00:00 UTC.`,
      period.dayResetsAt,
    );
  }
  if (monthUsage.output_tokens >= limits.monthlyOutputTokens) {
    log("warn", { evt: "rejected", reason: "monthly_output_tokens", invite: name });
    return limitError(
      `This invite's monthly output token limit is used up (${formatInt(limits.monthlyOutputTokens)} tokens). It resets on the 1st of the month, UTC.`,
      period.monthResetsAt,
    );
  }

  const parsed = await readMessagesBody(request, limits);
  if (parsed.error) {
    log("warn", { evt: "rejected", reason: parsed.reason, invite: name });
    return parsed.error;
  }
  const { body, forwardBody, clamped } = parsed;

  // Count the request on arrival, without holding up the forward.
  ctx.waitUntil(
    kvUpdate(env.USAGE, requestsKey, (stored) => toCount(stored) + 1, {
      ttl: DAY_COUNTER_TTL,
      current: requestsToday,
      label: { kind: "requests", invite: name },
    }),
  );

  let upstream;
  try {
    upstream = await fetch(`${upstreamBase(env)}/v1/messages${url.search}`, {
      method: "POST",
      headers: upstreamHeaders(request, env),
      body: forwardBody,
    });
  } catch (err) {
    log("error", { evt: "upstream_unreachable", invite: name, error: errorSummary(err) });
    return apiError(502, "api_error", "Could not reach the model provider. Try again shortly.");
  }

  const headers = pickHeaders(upstream.headers, PASSTHROUGH_RESPONSE_HEADERS);
  const summary = {
    evt: "messages",
    invite: name,
    model: body.model,
    stream: body.stream === true,
    status: upstream.status,
    ...(clamped ? { clamped_max_tokens: true } : {}),
  };

  // Errors pass straight through; there is no usage to meter.
  if (!upstream.ok || !upstream.body) {
    log("warn", { ...summary, ms: Date.now() - started });
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  const metered = meterUsage(upstream);
  ctx.waitUntil(
    metered.done.then(async ({ completed, usage, streamError }) => {
      log("info", {
        ...summary,
        completed,
        ms: Date.now() - started,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        ...(streamError ? { stream_error: streamError } : {}),
      });
      await recordTokens(env.USAGE, tokensKey, usage, name);
    }),
  );
  return new Response(metered.body, { status: upstream.status, headers });
}

/** Parse and validate the request body. Returns { body, forwardBody, clamped } or { error, reason }. */
async function readMessagesBody(request, limits) {
  const tooLarge = () => ({
    error: apiError(413, "request_too_large", "Request exceeds the maximum allowed size of 32 MB"),
    reason: "too_large",
  });
  if (Number(request.headers.get("content-length") || 0) > MAX_REQUEST_BYTES) return tooLarge();
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_REQUEST_BYTES) return tooLarge();

  const invalid = (message, reason) => ({ error: apiError(400, "invalid_request_error", message), reason });

  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    // Never log the parse error: its message quotes part of the body.
    return invalid("Request body is not valid JSON", "invalid_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalid("Request body must be a JSON object", "invalid_body");
  }

  if (typeof body.model !== "string" || !limits.models.includes(body.model)) {
    const shown = typeof body.model === "string" ? `"${body.model.slice(0, 100)}"` : "(missing)";
    return invalid(
      `model: ${shown} is not available through this gateway. Allowed models: ${limits.models.join(", ") || "(none)"}`,
      "model_not_allowed",
    );
  }

  if (body.max_tokens === undefined || body.max_tokens === null) {
    return invalid("max_tokens: Field required", "max_tokens_missing");
  }
  if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 0) {
    return invalid("max_tokens: must be a non-negative integer", "max_tokens_invalid");
  }

  // Forward the original bytes unless max_tokens has to change; every other
  // field (fallbacks, thinking, output_config, cache_control, ...) is untouched.
  if (body.max_tokens <= limits.maxTokens) return { body, forwardBody: raw, clamped: false };
  body.max_tokens = limits.maxTokens;
  return { body, forwardBody: JSON.stringify(body), clamped: true };
}

function upstreamHeaders(request, env) {
  // Built from scratch: the client's x-api-key / authorization (the invite code),
  // x-stainless-* and everything else never reach Anthropic.
  const headers = new Headers({
    "content-type": "application/json",
    "x-api-key": env.ANTHROPIC_API_KEY,
    "user-agent": "komposit-gateway",
  });
  for (const name of ["anthropic-version", "anthropic-beta"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function upstreamBase(env) {
  return String(env.UPSTREAM_BASE || DEFAULTS.UPSTREAM_BASE).replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Usage metering
//
// The response body passes through a TransformStream that hands every chunk to
// the client unchanged and lets a meter read the usage numbers on the side.
// This is used instead of ReadableStream.tee() on purpose: if the client goes
// away (the app's Stop button), the cancel reaches the upstream request, so
// Anthropic stops generating (and billing) at once, and the usage seen so far is
// still recorded. With tee(), the metering branch would keep the upstream
// generating after the client left, and a long generation would then be cut off
// by the runtime's 30 s waitUntil limit before its usage was recorded.

function meterUsage(upstream) {
  const contentType = upstream.headers.get("content-type") || "";
  const meter = contentType.includes("text/event-stream")
    ? new SseUsageMeter()
    : contentType.includes("json")
      ? new JsonUsageMeter()
      : null;
  if (!meter) {
    return { body: upstream.body, done: Promise.resolve({ completed: true, usage: emptyUsage(), streamError: null }) };
  }

  let meterBroken = false;
  const { readable, writable } = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (meterBroken) return;
      try {
        meter.push(chunk);
      } catch {
        meterBroken = true; // never let metering break the response
      }
    },
  });

  const done = upstream.body
    .pipeTo(writable)
    .then(
      () => true,
      () => false, // the client disconnected or the upstream failed mid-stream
    )
    .then((completed) => {
      let usage = emptyUsage();
      try {
        usage = meter.finish();
      } catch {
        // keep the empty usage
      }
      return { completed, usage, streamError: meter.streamError };
    });

  return { body: readable, done };
}

/** Reads usage from an Anthropic SSE stream: message_start, then cumulative message_delta counts. */
class SseUsageMeter {
  static MAX_PENDING = 1 << 20; // a single SSE line longer than this is skipped
  static METERED = new Set(["message_start", "message_delta", "error"]);

  constructor() {
    this.decoder = new TextDecoder();
    this.pending = ""; // incomplete last line
    this.skipLine = false;
    this.event = "";
    this.data = "";
    this.usage = emptyUsage();
    this.streamError = null;
  }

  push(chunk) {
    const text = this.decoder.decode(chunk, { stream: true });
    let start = 0;
    let newline;
    while ((newline = text.indexOf("\n", start)) !== -1) {
      const line = start === 0 ? this.pending + text.slice(0, newline) : text.slice(start, newline);
      if (start === 0) this.pending = "";
      if (this.skipLine) this.skipLine = false;
      else this.line(line);
      start = newline + 1;
    }
    this.pending = start === 0 ? this.pending + text : text.slice(start);
    if (this.pending.length > SseUsageMeter.MAX_PENDING) {
      this.pending = "";
      this.skipLine = true;
    }
  }

  finish() {
    const rest = this.pending + this.decoder.decode();
    this.pending = "";
    if (rest && !this.skipLine) this.line(rest);
    this.dispatch();
    return this.usage;
  }

  line(line) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === "") return this.dispatch();
    if (line.startsWith("event:")) {
      this.event = line.slice(6).trim();
    } else if (line.startsWith("data:") && (this.event === "" || SseUsageMeter.METERED.has(this.event))) {
      // Only the few events that carry usage are buffered and parsed; text deltas are skipped.
      const value = line.charCodeAt(5) === 32 ? line.slice(6) : line.slice(5);
      this.data = this.data ? `${this.data}\n${value}` : value;
    }
  }

  dispatch() {
    const { event, data } = this;
    this.event = "";
    this.data = "";
    if (!data) return;
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    const type = message?.type ?? event;
    if (type === "message_start") absorbUsage(this.usage, message.message?.usage);
    else if (type === "message_delta") absorbUsage(this.usage, message.usage);
    else if (type === "error") this.streamError = String(message.error?.type ?? "error").slice(0, 64);
  }
}

/** Reads `usage` from a non-streaming JSON Message once the body is complete. */
class JsonUsageMeter {
  static MAX_CHARS = 8 * 1024 * 1024;

  constructor() {
    this.decoder = new TextDecoder();
    this.text = "";
    this.overflow = false;
    this.usage = emptyUsage();
    this.streamError = null;
  }

  push(chunk) {
    if (this.overflow) return;
    this.text += this.decoder.decode(chunk, { stream: true });
    if (this.text.length > JsonUsageMeter.MAX_CHARS) {
      this.overflow = true;
      this.text = "";
    }
  }

  finish() {
    if (!this.overflow) {
      this.text += this.decoder.decode();
      try {
        absorbUsage(this.usage, JSON.parse(this.text)?.usage);
      } catch {
        // incomplete body (client went away): nothing to record
      }
    }
    this.text = "";
    return this.usage;
  }
}

function emptyUsage() {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

/** Fold an Anthropic `usage` object into `into`. The counts are cumulative, so later events replace earlier ones. */
function absorbUsage(into, usage) {
  if (!usage || typeof usage !== "object") return;
  // Server-side steps such as refusal fallbacks and compaction list each attempt
  // in usage.iterations; the top-level counts cover only the final attempt.
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  for (const field of USAGE_FIELDS) {
    let value = isCount(usage[field]) ? usage[field] : undefined;
    const parts = iterations.map((step) => step?.[field]).filter(isCount);
    if (parts.length) value = Math.max(value ?? 0, parts.reduce((sum, n) => sum + n, 0));
    if (value !== undefined) into[field] = Math.floor(value);
  }
}

function isCount(value) {
  return Number.isFinite(value) && value >= 0;
}

async function recordTokens(kv, key, usage, invite) {
  if (!USAGE_FIELDS.some((field) => usage[field] > 0)) return;
  await kvUpdate(
    kv,
    key,
    (stored) => {
      const total = normalizeUsage(stored);
      for (const field of USAGE_FIELDS) total[field] += usage[field];
      return { ...total, updated_at: new Date().toISOString() };
    },
    { ttl: MONTH_COUNTER_TTL, label: { kind: "tokens", invite } },
  );
}

// ---------------------------------------------------------------------------
// GET /v1/me and GET /health

async function handleMe(request, env) {
  const auth = await authenticate(request, env);
  if (auth.error) return auth.error;
  const limits = resolveLimits(auth.invite, env);
  const period = currentPeriod();
  const [requests, usage] = await Promise.all([
    readCount(env.USAGE, `req:${auth.hash}:${period.day}`),
    readUsage(env.USAGE, `tok:${auth.hash}:${period.month}`),
  ]);
  return json({
    name: typeof auth.invite.name === "string" ? auth.invite.name : null,
    limits,
    usage: {
      today: { date: period.day, requests, resetsAt: period.dayResetsAt.toISOString() },
      thisMonth: {
        month: period.month,
        outputTokens: usage.output_tokens,
        inputTokens: usage.input_tokens,
        cacheCreationInputTokens: usage.cache_creation_input_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens,
        resetsAt: period.monthResetsAt.toISOString(),
      },
    },
  });
}

function handleHealth(env) {
  const missing = [];
  if (!env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  if (!env.INVITES) missing.push("INVITES");
  if (!env.USAGE) missing.push("USAGE");
  return missing.length ? json({ ok: false, missing }, 503) : json({ ok: true });
}

// ---------------------------------------------------------------------------
// Invites and limits

async function authenticate(request, env) {
  const code = inviteCodeFrom(request.headers);
  if (!code) {
    log("warn", { evt: "auth_failed", reason: "missing" });
    return { error: authError() };
  }
  const hash = await sha256Hex(code);

  let raw;
  try {
    raw = await env.INVITES.get(`inv:${hash}`);
  } catch (err) {
    log("error", { evt: "kv_read_failed", store: "INVITES", error: errorSummary(err) });
    return { error: apiError(503, "api_error", "The gateway's storage is temporarily unavailable") };
  }
  if (raw === null) {
    log("warn", { evt: "auth_failed", reason: "unknown" });
    return { error: authError() };
  }

  const invite = parseJson(raw);
  if (!invite || typeof invite !== "object" || Array.isArray(invite)) {
    log("error", { evt: "invite_malformed", key: `inv:${hash.slice(0, 12)}...` });
    return { error: authError() };
  }
  if (invite.disabled) {
    log("warn", { evt: "auth_failed", reason: "disabled", invite: inviteName(invite) });
    return { error: authError() };
  }
  return { hash, invite };
}

/** The invite code from x-api-key, or from `Authorization: Bearer` (what SDK 1.x sends). */
function inviteCodeFrom(headers) {
  let code = headers.get("x-api-key");
  if (!code) {
    const match = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") || "");
    code = match ? match[1] : "";
  }
  code = code.trim();
  return code && code.length <= MAX_CODE_LENGTH ? code : null;
}

function authError() {
  return apiError(401, "authentication_error", "Invalid invite code");
}

function inviteName(invite) {
  return typeof invite.name === "string" && invite.name ? invite.name.slice(0, 80) : "(unnamed)";
}

/** Per-invite values win; otherwise the Worker vars; otherwise the built-in defaults. */
function resolveLimits(invite, env) {
  const inviteModels = Array.isArray(invite.models) ? invite.models.filter((m) => typeof m === "string" && m) : [];
  return {
    dailyRequests:
      nonNegativeInt(invite.dailyRequests) ??
      nonNegativeInt(env.DEFAULT_DAILY_REQUESTS) ??
      DEFAULTS.DEFAULT_DAILY_REQUESTS,
    monthlyOutputTokens:
      nonNegativeInt(invite.monthlyOutputTokens) ??
      nonNegativeInt(env.DEFAULT_MONTHLY_OUTPUT_TOKENS) ??
      DEFAULTS.DEFAULT_MONTHLY_OUTPUT_TOKENS,
    maxTokens: nonNegativeInt(env.MAX_TOKENS_CAP) ?? DEFAULTS.MAX_TOKENS_CAP,
    // An invite's own `models` list replaces ALLOWED_MODELS for that invite.
    models: inviteModels.length ? inviteModels : splitList(env.ALLOWED_MODELS ?? DEFAULTS.ALLOWED_MODELS),
  };
}

function limitError(message, resetsAt) {
  const seconds = Math.max(1, Math.ceil((resetsAt.getTime() - Date.now()) / 1000));
  // x-should-retry: false stops the Anthropic SDKs from retrying a quota error.
  // Without it, SDK 1.x would honour retry-after and sleep until the reset.
  return apiError(429, "rate_limit_error", message, { "retry-after": String(seconds), "x-should-retry": "false" });
}

function currentPeriod(now = new Date()) {
  const iso = now.toISOString();
  const [y, m, d] = [now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()];
  return {
    day: iso.slice(0, 10),
    month: iso.slice(0, 7),
    dayResetsAt: new Date(Date.UTC(y, m, d + 1)),
    monthResetsAt: new Date(Date.UTC(y, m + 1, 1)),
  };
}

// ---------------------------------------------------------------------------
// KV helpers

async function readCount(kv, key) {
  return toCount(parseJson(await kv.get(key)));
}

async function readUsage(kv, key) {
  return normalizeUsage(parseJson(await kv.get(key)));
}

function normalizeUsage(stored) {
  const usage = emptyUsage();
  if (stored && typeof stored === "object") {
    for (const field of USAGE_FIELDS) usage[field] = toCount(stored[field]);
  }
  return usage;
}

function toCount(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Read-modify-write with a short retry. Failures are logged, never thrown: counting must not break requests. */
async function kvUpdate(kv, key, update, { ttl, current, label }) {
  for (let attempt = 1; ; attempt++) {
    try {
      const stored = attempt === 1 && current !== undefined ? current : parseJson(await kv.get(key));
      await kv.put(key, JSON.stringify(update(stored)), { expirationTtl: ttl });
      return;
    } catch (err) {
      if (attempt >= KV_WRITE_ATTEMPTS) {
        log("error", { evt: "kv_write_failed", ...label, error: errorSummary(err) });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1100 * attempt));
    }
  }
}

// ---------------------------------------------------------------------------
// Small utilities

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function parseJson(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function nonNegativeInt(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function splitList(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function pickHeaders(source, names) {
  const headers = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function formatInt(n) {
  return n.toLocaleString("en-US");
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

/** Errors in the Anthropic API's shape, so the SDK maps them to its typed error classes. */
function apiError(status, type, message, extraHeaders) {
  return json({ type: "error", error: { type, message } }, status, extraHeaders);
}

function errorSummary(err) {
  return `${err?.name || "Error"}: ${String(err?.message ?? err).slice(0, 200)}`;
}

function log(level, entry) {
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
