// End-to-end tests for komposit-gateway.
//
// Starts a mock Anthropic upstream (test/mock-upstream.mjs) and a mock Google
// (test/mock-google.mjs), seeds a throwaway local KV with test invites using
// `wrangler kv bulk put --local`, creates a throwaway local D1 with
// `wrangler d1 migrations apply --local` (plus two ready-made accounts), runs the
// Worker under `wrangler dev --local` (miniflare: no Cloudflare account, no
// network) with UPSTREAM_BASE and the Google endpoints pointed at the mocks, then
// drives it over HTTP like a tester, or a browser, would.
//
//   npm test                       from gateway/
//   DEBUG_GATEWAY=1 npm test       also print wrangler dev's output
//   KEEP_TEST_STATE=1 npm test     keep .wrangler/test-state-*/ (the local KV and D1) afterwards
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { d1Args, grantSql, listSql, normalizeEmail, parseAllowance, revokeSql, shellQuote as grantShellQuote, sqlString } from "../scripts/grant.mjs";
import { generateInviteCode, hashInviteCode } from "../scripts/mint-invite.mjs";
import { readIdToken, signInConfig } from "../src/accounts.js";
import { startMockGoogle } from "./mock-google.mjs";
import { MOCK_JSON_USAGE, MOCK_STREAM_USAGE, MOCK_TEXT, startMockUpstream } from "./mock-upstream.mjs";

const execFileAsync = promisify(execFile);
const GATEWAY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(GATEWAY_DIR, "node_modules", "wrangler", "bin", "wrangler.js");
const MINT = path.join(GATEWAY_DIR, "scripts", "mint-invite.mjs");
const GRANT = path.join(GATEWAY_DIR, "scripts", "grant.mjs");

// Sign-in. The app's hosted page, and the app's own local page.
const APP = "https://app.komposit.werq.dev";
const LOCAL_PAGE = "http://127.0.0.1:4321";
const GOOGLE_CLIENT_ID = "komposit-test.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = `GOCSPX-test-${randomBytes(12).toString("hex")}`;
const SESSION = /^ks_[a-z2-7]{52}$/;
// Everything sign-in hands around that must never show up in the Worker's logs.
const signInSecrets = new Set();
const personalData = new Set();

// Accounts written straight into D1 before the Worker starts, like the invites in KV.
const SEEDED = {
  browser: { id: 9001, sub: "g-seed-browser", email: "browser.tester@example.com", name: "Browser Tester", allowance: 1_000_000 },
  expired: { id: 9002, sub: "g-seed-expired", email: "expired.tester@example.com", name: "Expired Tester", allowance: 1_000_000, expired: true },
};
for (const account of Object.values(SEEDED)) {
  account.session = sessionToken();
  signInSecrets.add(account.session);
  personalData.add(account.email).add(account.name).add(account.sub);
}

const OWNER_KEY = `sk-ant-owner-test-${randomBytes(16).toString("hex")}`;
// The defaults in wrangler.toml; the tests deliberately do not override them.
const CAP = 64000;
const DEFAULT_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
// Planted in request bodies to prove bodies never reach the logs.
const BODY_MARKER = `body-marker-${randomBytes(6).toString("hex")}`;

// One invite per scenario so usage from one test never bleeds into another.
const INVITES = {
  main: { name: "Main Tester" },
  usage: { name: "Usage Tester" },
  me: { name: "Me Tester", dailyRequests: 50, monthlyOutputTokens: 5000 },
  daily: { name: "Daily Limit Tester", dailyRequests: 2 },
  budget: { name: "Budget Tester", monthlyOutputTokens: 10 },
  haiku: { name: "Haiku Only", models: ["claude-haiku-5-5"] },
  blocked: { name: "Blocked Tester", dailyRequests: 0 },
  errors: { name: "Errors Tester" },
  disconnect: { name: "Disconnect Tester" },
  sdk: { name: "SDK Tester" },
  disabled: { name: "Disabled Tester", disabled: true },
};
const codes = Object.fromEntries(Object.keys(INVITES).map((key) => [key, generateInviteCode()]));

let mock;
let google;
let worker;
let gateway;
let stateDir;
let persistDir;
let workerOutput = "";

before(
  async () => {
    stateDir = path.join(GATEWAY_DIR, ".wrangler", `test-state-${process.pid}-${Date.now()}`);
    persistDir = path.join(stateDir, "persist");
    await mkdir(persistDir, { recursive: true });

    mock = await startMockUpstream();
    const port = await freePort();
    gateway = `http://127.0.0.1:${port}`;
    google = await startMockGoogle({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      redirectUris: [`${gateway}/auth/google/callback`],
    });

    // Seed INVITES the way an operator would: with wrangler, into a fresh local KV.
    const seedFile = path.join(stateDir, "invites.json");
    const entries = Object.entries(INVITES).map(([key, record]) => ({
      key: `inv:${hashInviteCode(codes[key])}`,
      value: JSON.stringify(record),
    }));
    await writeFile(seedFile, JSON.stringify(entries));
    const seedInvites = execFileAsync(
      process.execPath,
      [WRANGLER, "kv", "bulk", "put", seedFile, "--binding", "INVITES", "--local", "--persist-to", persistDir],
      { cwd: GATEWAY_DIR, env: wranglerEnv() },
    );
    // Create the local D1 with the migrations an operator applies, then add the seeded accounts.
    const accountsFile = path.join(stateDir, "accounts.sql");
    await writeFile(accountsFile, seedAccountsSql());
    const seedAccounts = (async () => {
      await execFileAsync(process.execPath, [WRANGLER, "d1", "migrations", "apply", "DB", "--local", "--persist-to", persistDir], {
        cwd: GATEWAY_DIR,
        env: wranglerEnv(),
      });
      await execFileAsync(
        process.execPath,
        [WRANGLER, "d1", "execute", "DB", "--local", "--persist-to", persistDir, "--file", accountsFile],
        { cwd: GATEWAY_DIR, env: wranglerEnv() },
      );
    })();
    await Promise.all([seedInvites, seedAccounts]);

    worker = spawn(
      process.execPath,
      [
        WRANGLER, "dev", "--local",
        "--ip", "127.0.0.1",
        "--port", String(port),
        // Without this, wrangler dev gives the Worker the [[routes]] hostname as its
        // URL, and sign-in builds its redirect_uri from that URL.
        "--local-upstream", `127.0.0.1:${port}`,
        "--inspector-port", String(await freePort()),
        "--persist-to", persistDir,
        "--show-interactive-dev-session=false",
        // Only the upstreams and the secrets are test-specific; limits and
        // RETURN_ORIGINS come from wrangler.toml.
        "--var", `UPSTREAM_BASE:${mock.url}`,
        "--var", `ANTHROPIC_API_KEY:${OWNER_KEY}`,
        "--var", `GOOGLE_CLIENT_ID:${GOOGLE_CLIENT_ID}`,
        "--var", `GOOGLE_CLIENT_SECRET:${GOOGLE_CLIENT_SECRET}`,
        "--var", `GOOGLE_AUTH_URL:${google.authUrl}`,
        "--var", `GOOGLE_TOKEN_URL:${google.tokenUrl}`,
      ],
      { cwd: GATEWAY_DIR, env: wranglerEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const capture = (chunk) => {
      workerOutput += chunk;
      if (process.env.DEBUG_GATEWAY) process.stderr.write(chunk);
    };
    worker.stdout.on("data", capture);
    worker.stderr.on("data", capture);
    process.once("exit", () => worker.kill("SIGKILL"));

    await waitFor(
      async () => {
        if (!isRunning(worker)) throw new Error(`wrangler dev exited early:\n${workerOutput}`);
        const res = await fetch(`${gateway}/health`).catch(() => null);
        return res?.status === 200;
      },
      "wrangler dev to start",
      90_000,
      250,
    );
  },
  { timeout: 120_000 },
);

after(async () => {
  if (isRunning(worker)) {
    const exited = new Promise((resolve) => worker.once("exit", resolve));
    worker.kill("SIGTERM");
    await Promise.race([exited, sleep(5000)]);
    if (isRunning(worker)) worker.kill("SIGKILL");
  }
  await mock?.close();
  await google?.close();
  if (stateDir && !process.env.KEEP_TEST_STATE) await rm(stateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

test("GET /health reports a configured gateway, sign-in included", async () => {
  const res = await fetch(`${gateway}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, signIn: true });
});

test("every other route is an Anthropic-shaped 404, with no CORS headers", async () => {
  const routes = [
    ["GET", "/"],
    ["GET", "/v1/messages"],
    ["GET", "/v1/models"],
    ["POST", "/v1/messages/count_tokens"],
    ["OPTIONS", "/v1/messages"],
  ];
  for (const [method, route] of routes) {
    const res = await fetch(`${gateway}${route}`, { method, headers: { "x-api-key": codes.main } });
    await expectError(res, 404, "not_found_error");
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  }
});

test("a missing, unknown or disabled invite code gets a 401 authentication_error", async () => {
  const before = mock.calls.length;
  const attempts = [
    post(undefined, request()),
    post("kp_thisisnotarealinvitecode", request({ stream: true })),
    post("kp_thisisnotarealinvitecode", request(), { auth: "bearer" }),
    post(codes.disabled, request()),
    fetch(`${gateway}/v1/me`, { headers: { "x-api-key": codes.disabled } }),
    fetch(`${gateway}/v1/me`),
  ];
  for (const res of await Promise.all(attempts)) {
    const body = await expectError(res, 401, "authentication_error");
    assert.equal(body.error.message, "Invalid invite code");
  }
  assert.equal(mock.calls.length, before, "nothing reached the upstream");
});

test("a valid invite streams through; the upstream sees the owner key, never the invite", async () => {
  const sent = request({
    stream: true,
    max_tokens: 2048,
    system: [{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }],
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "low" },
    fallbacks: "default",
    metadata: { user_id: "tester-123" },
  });
  const res = await post(codes.main, sent, {
    headers: {
      "anthropic-beta": "server-side-fallback-2026-07-01,another-beta-2026-01-01",
      "x-stainless-lang": "js",
      "x-stainless-retry-count": "0",
      "x-stainless-os": "MacOS",
    },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/event-stream/);
  const text = await res.text();
  const call = mock.lastCall();

  // The stream arrives byte-for-byte as the upstream sent it.
  assert.equal(text, call.sent);
  assert.match(text, /event: message_start[\s\S]*event: content_block_delta[\s\S]*event: message_delta[\s\S]*event: message_stop/);
  assert.equal(res.headers.get("request-id"), call.requestId);
  assert.equal(res.headers.get("anthropic-organization-id"), null, "the owner's org id is not passed on");
  assert.equal(res.headers.get("anthropic-ratelimit-requests-limit"), null);

  // What the upstream received.
  assert.equal(call.url, "/v1/messages");
  assert.equal(call.headers["x-api-key"], OWNER_KEY);
  assert.equal(call.headers.authorization, undefined);
  assert.equal(call.headers["anthropic-version"], "2023-06-01");
  assert.equal(call.headers["anthropic-beta"], "server-side-fallback-2026-07-01,another-beta-2026-01-01");
  assert.equal(call.headers["content-type"], "application/json");
  assert.deepEqual(Object.keys(call.headers).filter((name) => name.startsWith("x-stainless")), []);
  assert.ok(!JSON.stringify(call.headers).includes(codes.main), "the invite code is not forwarded");
  assert.equal(call.rawBody, JSON.stringify(sent), "the body is forwarded byte-for-byte");
});

test("Authorization: Bearer invite codes work too (what Anthropic SDK 1.x sends)", async () => {
  // Older SDKs add ?beta=true for beta calls; the query string is passed on as is.
  const res = await post(codes.main, request(), { auth: "bearer", query: "?beta=true" });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).content[0].text, MOCK_TEXT);
  const call = mock.lastCall();
  assert.equal(call.url, "/v1/messages?beta=true");
  assert.equal(call.headers["x-api-key"], OWNER_KEY);
  assert.equal(call.headers.authorization, undefined);
});

test("max_tokens above MAX_TOKENS_CAP is clamped; every other field is forwarded untouched", async () => {
  const sent = request({
    max_tokens: 200_000,
    stream: true,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    fallbacks: [{ model: "claude-sonnet-5-5" }],
    messages: [
      { role: "user", content: [{ type: "text", text: `hi ${BODY_MARKER}`, cache_control: { type: "ephemeral", ttl: "1h" } }] },
    ],
  });
  const res = await post(codes.main, sent);
  assert.equal(res.status, 200);
  await res.text();
  const forwarded = mock.lastCall().body;
  assert.equal(forwarded.max_tokens, CAP);
  assert.deepEqual({ ...forwarded, max_tokens: sent.max_tokens }, sent);

  // At the cap or below, max_tokens is left alone.
  const atCap = await post(codes.main, request({ max_tokens: CAP }));
  assert.equal(atCap.status, 200);
  await atCap.text();
  assert.equal(mock.lastCall().body.max_tokens, CAP);
});

test("a disallowed model or a malformed body gets a 400 invalid_request_error and never reaches the upstream", async () => {
  const before = mock.calls.length;
  const cases = [
    [request({ model: "claude-fable-5-1" }), /model: "claude-fable-5-1" is not available/],
    [request({ model: "claude-opus-4-8" }), /Allowed models: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5/],
    [{ max_tokens: 10, messages: [] }, /model: \(missing\)/],
    [`{"messages": "${BODY_MARKER}", oops`, /not valid JSON/],
    ["[1, 2, 3]", /must be a JSON object/],
    [request({ max_tokens: undefined }), /max_tokens: Field required/],
    [request({ max_tokens: -1 }), /non-negative integer/],
    [request({ max_tokens: "lots" }), /non-negative integer/],
  ];
  for (const [body, pattern] of cases) {
    const error = await expectError(await post(codes.main, body), 400, "invalid_request_error");
    assert.match(error.error.message, pattern);
  }

  // An invite's own `models` list replaces ALLOWED_MODELS.
  const opus = await post(codes.haiku, request({ model: "claude-opus-5-5" }));
  assert.match((await expectError(opus, 400, "invalid_request_error")).error.message, /Allowed models: claude-haiku-5-5$/);
  assert.equal(mock.calls.length, before, "nothing reached the upstream");

  const haiku = await post(codes.haiku, request({ model: "claude-haiku-5-5" }));
  assert.equal(haiku.status, 200);
  await haiku.text();
  // Only the request that was forwarded counts toward the daily limit.
  await waitFor(async () => (await me(codes.haiku)).usage.today.requests === 1, "the forwarded request to be counted");
  await sleep(300);
  assert.equal((await me(codes.haiku)).usage.today.requests, 1);
});

test("token usage from streamed and non-streamed responses is recorded", async () => {
  const streamed = await post(codes.usage, request({ stream: true }));
  assert.equal(streamed.status, 200);
  await streamed.text();
  await waitFor(
    async () => (await me(codes.usage)).usage.thisMonth.outputTokens === MOCK_STREAM_USAGE.output_tokens,
    "streamed usage to be recorded",
  );

  const plain = await post(codes.usage, request());
  assert.equal(plain.status, 200);
  await plain.json();
  const expected = {
    inputTokens: MOCK_STREAM_USAGE.input_tokens + MOCK_JSON_USAGE.input_tokens,
    outputTokens: MOCK_STREAM_USAGE.output_tokens + MOCK_JSON_USAGE.output_tokens,
    cacheCreationInputTokens: MOCK_STREAM_USAGE.cache_creation_input_tokens + MOCK_JSON_USAGE.cache_creation_input_tokens,
    cacheReadInputTokens: MOCK_STREAM_USAGE.cache_read_input_tokens + MOCK_JSON_USAGE.cache_read_input_tokens,
  };
  const info = await waitFor(async () => {
    const current = await me(codes.usage);
    return current.usage.thisMonth.outputTokens === expected.outputTokens ? current : null;
  }, "non-streamed usage to be recorded");
  const { inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens } = info.usage.thisMonth;
  assert.deepEqual({ inputTokens, outputTokens, cacheCreationInputTokens, cacheReadInputTokens }, expected);
  assert.equal(info.usage.today.requests, 2);
});

test("GET /v1/me returns the invite's name, limits and usage", async () => {
  const fresh = await me(codes.me);
  const now = new Date().toISOString();
  assert.deepEqual(fresh.name, "Me Tester");
  assert.deepEqual(fresh.limits, { dailyRequests: 50, monthlyOutputTokens: 5000, maxTokens: CAP, models: DEFAULT_MODELS });
  assert.equal(fresh.usage.today.date, now.slice(0, 10));
  assert.equal(fresh.usage.today.requests, 0);
  assert.ok(new Date(fresh.usage.today.resetsAt) > new Date(now));
  assert.equal(fresh.usage.thisMonth.month, now.slice(0, 7));
  assert.equal(fresh.usage.thisMonth.outputTokens, 0);
  assert.ok(new Date(fresh.usage.thisMonth.resetsAt) > new Date(now));

  const res = await post(codes.me, request({ stream: true }));
  await res.text();
  const after = await waitFor(async () => {
    const current = await me(codes.me);
    return current.usage.thisMonth.outputTokens > 0 ? current : null;
  }, "usage to show up in /v1/me");
  assert.equal(after.usage.today.requests, 1);
  assert.equal(after.usage.thisMonth.outputTokens, MOCK_STREAM_USAGE.output_tokens);
  assert.equal(after.usage.thisMonth.inputTokens, MOCK_STREAM_USAGE.input_tokens);

  // Gateway defaults apply where the invite sets nothing; Bearer works here too.
  const defaults = await fetch(`${gateway}/v1/me`, { headers: { authorization: `Bearer ${codes.main}` } });
  assert.equal(defaults.status, 200);
  assert.deepEqual((await defaults.json()).limits, {
    dailyRequests: 300,
    monthlyOutputTokens: 2_000_000,
    maxTokens: CAP,
    models: DEFAULT_MODELS,
  });
});

test("going over the daily request limit gets a 429 rate_limit_error", async () => {
  const before = mock.calls.length;
  for (let n = 1; n <= 2; n++) {
    const res = await post(codes.daily, request());
    assert.equal(res.status, 200);
    await res.json();
    await waitFor(async () => (await me(codes.daily)).usage.today.requests === n, `request ${n} to be counted`);
  }
  const res = await post(codes.daily, request());
  const error = await expectError(res, 429, "rate_limit_error");
  assert.match(error.error.message, /daily request limit is used up \(2 requests per day\)/);
  assert.equal(res.headers.get("x-should-retry"), "false");
  assert.ok(Number(res.headers.get("retry-after")) > 0);
  assert.equal(mock.calls.length, before + 2, "the third request never reached the upstream");
  assert.equal((await me(codes.daily)).usage.today.requests, 2, "rejected requests are not counted");
});

test("going over the monthly output-token budget gets a 429 rate_limit_error", async () => {
  const first = await post(codes.budget, request({ stream: true }));
  assert.equal(first.status, 200);
  await first.text();
  await waitFor(async () => (await me(codes.budget)).usage.thisMonth.outputTokens >= 10, "output tokens to be recorded");

  const res = await post(codes.budget, request({ stream: true }));
  const error = await expectError(res, 429, "rate_limit_error");
  assert.match(error.error.message, /monthly output token limit is used up \(10 tokens\)/);
  assert.equal(res.headers.get("x-should-retry"), "false");
});

test("upstream errors pass straight through with their status, body and retry headers", async () => {
  const res = await post(codes.errors, request({ metadata: { user_id: "mock:overloaded" } }));
  assert.equal(res.status, 529);
  assert.deepEqual(await res.json(), { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
  assert.equal(res.headers.get("request-id"), mock.lastCall().requestId);
  assert.equal(res.headers.get("x-should-retry"), "true");
  assert.equal(res.headers.get("retry-after"), "7");

  const info = await waitFor(async () => {
    const current = await me(codes.errors);
    return current.usage.today.requests === 1 ? current : null;
  }, "the request to be counted");
  assert.equal(info.usage.thisMonth.inputTokens, 0, "an error has no usage to record");
  assert.equal(info.usage.thisMonth.outputTokens, 0);
});

test("a client that hangs up mid-stream cancels the upstream request; the usage so far is recorded", async () => {
  const controller = new AbortController();
  const res = await post(codes.disconnect, request({ stream: true, metadata: { user_id: "mock:slow" } }), {
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = "";
  while (!received.includes("content_block_delta")) {
    const { value, done } = await reader.read();
    if (done) break;
    received += decoder.decode(value, { stream: true });
  }
  controller.abort();
  const call = mock.lastCall();
  await waitFor(() => call.clientClosedEarly, "the gateway to close the upstream connection", 5000);
  assert.equal(call.finished, false, "the upstream did not get to finish its ~10 s stream");

  const info = await waitFor(async () => {
    const current = await me(codes.disconnect);
    return current.usage.thisMonth.inputTokens > 0 ? current : null;
  }, "partial usage to be recorded");
  assert.equal(info.usage.thisMonth.inputTokens, MOCK_STREAM_USAGE.input_tokens);
  assert.ok(info.usage.thisMonth.outputTokens < 400, "the final output count never arrived");
});

test("the official Anthropic SDK streams through the gateway and gets typed errors", async () => {
  let attempts = 0;
  const countingFetch = (url, init) => {
    attempts++;
    return fetch(url, init);
  };
  const client = new Anthropic({ baseURL: gateway, apiKey: codes.sdk, fetch: countingFetch, maxRetries: 2 });

  // The same call shape as Komposit's companion/providers/anthropic.mjs.
  const betas = ["thinking-display-updates-2026-08-18", "server-side-fallback-2026-07-01"];
  const params = {
    model: "claude-opus-5-5",
    max_tokens: 64000,
    system: [{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }],
    tools: [
      {
        name: "inspect",
        description: "Inspect the document",
        input_schema: { type: "object", properties: {} },
        eager_input_streaming: true,
      },
    ],
    messages: [{ role: "user", content: "Say hello" }],
    thinking: { type: "adaptive", display: "updates" },
    output_config: { effort: "medium" },
    fallbacks: "default",
    cache_control: { type: "ephemeral" },
  };
  const streamed = await client.beta.messages.stream({ ...params, betas }).finalMessage();
  assert.equal(streamed.content[0].text, MOCK_TEXT);
  assert.equal(streamed.usage.output_tokens, MOCK_STREAM_USAGE.output_tokens);
  const call = mock.lastCall();
  assert.equal(call.headers["x-api-key"], OWNER_KEY);
  assert.equal(call.headers.authorization, undefined, "the SDK's Bearer header is not forwarded");
  assert.equal(call.headers["anthropic-version"], "2026-10-21", "the SDK's API version is passed on");
  assert.equal(call.headers["anthropic-beta"], betas.join(","));
  assert.deepEqual(call.body, { ...params, stream: true });

  const plain = await client.messages.create({
    model: "claude-haiku-5-5",
    max_tokens: 64,
    messages: [{ role: "user", content: "Say hello" }],
  });
  assert.equal(plain.content[0].text, MOCK_TEXT);

  const stranger = new Anthropic({ baseURL: gateway, apiKey: "kp_thisisnotarealinvitecode", fetch: countingFetch });
  await assert.rejects(
    stranger.messages.create({ model: "claude-opus-5-5", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    (err) => err instanceof Anthropic.AuthenticationError && /Invalid invite code/.test(err.message),
  );
  await assert.rejects(
    client.messages.create({ model: "claude-opus-4-8", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    (err) => err instanceof Anthropic.BadRequestError && /not available through this gateway/.test(err.message),
  );

  attempts = 0;
  const blocked = new Anthropic({ baseURL: gateway, apiKey: codes.blocked, fetch: countingFetch });
  await assert.rejects(
    blocked.messages.create({ model: "claude-opus-5-5", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    // The app shows err.error.error.message to the person when it matches /invite|limit/i.
    (err) => err instanceof Anthropic.RateLimitError && /invite's daily request limit/.test(err.error?.error?.message),
  );
  assert.equal(attempts, 1, "x-should-retry: false stops the SDK from retrying a quota 429");
});

let mintedCode;

test("mint-invite's printed --local command creates a working invite, and its revoke command disables it", async () => {
  const { stdout } = await execFileAsync(process.execPath, [MINT, "CLI Tester", "--daily", "5", "--monthly-output", "1000"], {
    cwd: GATEWAY_DIR,
  });
  mintedCode = stdout.match(/\bkp_[a-z2-7]{24}\b/)?.[0];
  assert.ok(mintedCode, "prints a kp_ code");
  const hash = createHash("sha256").update(mintedCode).digest("hex");
  const commands = stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("npx wrangler"));
  const remote = commands.find((line) => line.endsWith("--remote"));
  const local = commands.find((line) => line.endsWith("--local"));
  assert.ok(remote?.includes(`kv key put --binding INVITES "inv:${hash}"`), "prints the --remote put command");
  assert.ok(local?.includes(`"inv:${hash}"`), "prints the --local put command");

  // Run the printed command exactly as printed, pointed at this test's local KV.
  await execFileAsync("/bin/sh", ["-c", `${local} --persist-to ${shellQuote(persistDir)}`], {
    cwd: GATEWAY_DIR,
    env: wranglerEnv(),
  });
  const info = await waitFor(async () => {
    const res = await fetch(`${gateway}/v1/me`, { headers: { "x-api-key": mintedCode } });
    return res.status === 200 ? res.json() : null;
  }, "the minted invite to authenticate");
  assert.equal(info.name, "CLI Tester");
  assert.equal(info.limits.dailyRequests, 5);
  assert.equal(info.limits.monthlyOutputTokens, 1000);

  const { stdout: revokeOut } = await execFileAsync(process.execPath, [MINT, "revoke", hash, "--name", "CLI Tester"], {
    cwd: GATEWAY_DIR,
  });
  const disable = revokeOut
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("npx wrangler kv key put") && line.endsWith("--remote"));
  assert.ok(disable?.includes('"disabled":true'), "prints a disable command");
  await execFileAsync("/bin/sh", ["-c", `${disable.replace(/--remote$/, "--local")} --persist-to ${shellQuote(persistDir)}`], {
    cwd: GATEWAY_DIR,
    env: wranglerEnv(),
  });
  await waitFor(
    async () => (await fetch(`${gateway}/v1/me`, { headers: { "x-api-key": mintedCode } })).status === 401,
    "the revoked invite to be rejected",
  );
});

// ---------------------------------------------------------------------------
// Sign-in with Google, accounts and CORS

test("sign-in starts at Google with PKCE (S256), a state and a nonce, and refuses a return origin it doesn't know", async () => {
  const first = await startSignIn(APP);
  const second = await startSignIn(APP);
  const params = Object.fromEntries(first.location.searchParams);
  assert.equal(`${first.location.origin}${first.location.pathname}`, google.authUrl);
  assert.equal(params.client_id, GOOGLE_CLIENT_ID);
  assert.equal(params.redirect_uri, `${gateway}/auth/google/callback`);
  assert.equal(params.response_type, "code");
  assert.equal(params.scope, "openid email profile");
  assert.equal(params.prompt, "select_account");
  assert.equal(params.code_challenge_method, "S256");
  for (const name of ["code_challenge", "state", "nonce"]) {
    assert.match(params[name], /^[A-Za-z0-9_-]{43}$/, name);
    assert.notEqual(params[name], second.location.searchParams.get(name), `${name} is fresh for every sign-in`);
  }
  assert.equal(params.code_verifier, undefined, "the PKCE verifier stays in the gateway");
  assert.equal(first.res.headers.get("cache-control"), "no-store");

  // The state also goes into an HttpOnly cookie for /auth/google/ only, so only this browser can finish.
  const cookie = first.res.headers.get("set-cookie");
  assert.ok(cookie.startsWith(`ks_state=${params.state}; `), cookie);
  for (const part of ["Max-Age=600", "Path=/auth/google/", "HttpOnly", "SameSite=Lax"]) assert.ok(cookie.includes(part), part);

  // The app's own local page may start a sign-in too.
  for (const origin of [LOCAL_PAGE, "http://localhost:4330", `${APP}/`]) await startSignIn(origin);

  // Anything else gets a plain page: no redirect, no cookie.
  const foreign = [
    "https://evil.example",
    "https://app.komposit.werq.dev.evil.example",
    "https://app.komposit.werq.dev/somewhere",
    "https://app.komposit.werq.dev?then=https://evil.example",
    "https://someone@app.komposit.werq.dev",
    "http://app.komposit.werq.dev",
    "http://127.0.0.1:4331",
    "http://127.0.0.1:8080",
    "null",
    "javascript:alert(1)",
    "",
  ];
  for (const origin of foreign) {
    const res = await fetch(`${gateway}/auth/google/start?return=${encodeURIComponent(origin)}`, { redirect: "manual" });
    assert.equal(res.status, 400, origin);
    assert.equal(res.headers.get("location"), null, origin);
    assert.equal(res.headers.get("set-cookie"), null, origin);
    assert.match(res.headers.get("content-type"), /^text\/html/);
    assert.match(await res.text(), /come from Komposit/);
  }
  const missing = await fetch(`${gateway}/auth/google/start`, { redirect: "manual" });
  assert.equal(missing.status, 400);
  await missing.text();
});

test("a first sign-in creates an account with no allowance and hands the page its session in the URL fragment", async () => {
  const person = { sub: "g-first-1", email: "First.Person@Example.com", email_verified: true, name: "First Person" };
  const result = await signIn(person, { returnOrigin: APP });
  assert.equal(result.res.status, 302);
  assert.match(result.location, /^https:\/\/app\.komposit\.werq\.dev\/#ks=ks_[a-z2-7]{52}$/);
  assert.match(result.session, SESSION);
  assert.ok(result.res.headers.get("set-cookie").startsWith("ks_state=; Max-Age=0;"), "the state cookie is cleared");

  // The code was exchanged with the client secret, the same redirect_uri and the PKCE
  // verifier (the mock checks the verifier against the challenge, as Google does).
  const exchange = google.lastTokenCall();
  assert.equal(exchange.status, 200);
  assert.equal(exchange.params.client_secret, GOOGLE_CLIENT_SECRET);
  assert.equal(exchange.params.redirect_uri, `${gateway}/auth/google/callback`);
  assert.match(exchange.params.code_verifier, /^[A-Za-z0-9_-]{43}$/);

  const info = await me(result.session);
  const { usage, sessionExpiresAt, ...rest } = info;
  assert.deepEqual(rest, {
    kind: "account",
    name: "First Person",
    email: "first.person@example.com",
    allowance: 0,
    limits: { dailyRequests: 300, monthlyOutputTokens: 0, maxTokens: CAP, models: DEFAULT_MODELS },
  });
  assert.equal(usage.today.requests, 0);
  assert.equal(usage.thisMonth.outputTokens, 0);
  const days = (Date.parse(sessionExpiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30, `the session lasts 30 days (${days})`);
  const bearer = await fetch(`${gateway}/v1/me`, { headers: { authorization: `Bearer ${result.session}` } });
  assert.equal((await bearer.json()).kind, "account");

  // No allowance yet: a 403 with a plain message, and nothing reaches Anthropic.
  const before = mock.calls.length;
  const denied = await expectError(await post(result.session, request({ stream: true })), 403, "permission_error");
  assert.equal(denied.error.message, "This account has no Komposit allowance yet.");
  const sdk = new Anthropic({ baseURL: gateway, apiKey: result.session, maxRetries: 0 });
  await assert.rejects(
    sdk.messages.create({ model: "claude-opus-5-5", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    (err) => err instanceof Anthropic.PermissionDeniedError && /no Komposit allowance/.test(err.message),
  );
  assert.equal(mock.calls.length, before);

  // Signing in again finds the same account and adds a second session; both work.
  const again = await signIn({ ...person, name: "First P. Person" });
  assert.match(again.location, /^http:\/\/127\.0\.0\.1:4321\/#ks=/);
  assert.notEqual(again.session, result.session);
  assert.equal((await me(again.session)).name, "First P. Person");
  assert.equal((await me(result.session)).name, "First P. Person");
});

test("a bad, replayed, expired or other browser's state is refused", async () => {
  // A state the gateway never issued, or none: a plain page, nothing exchanged.
  const exchanges = google.tokenCalls.length;
  for (const query of [`code=4/0Mockabc&state=${"x".repeat(43)}`, "code=4/0Mockabc", ""]) {
    const res = await fetch(`${gateway}/auth/google/callback?${query}`, { redirect: "manual" });
    assert.equal(res.status, 400, query);
    assert.equal(res.headers.get("location"), null);
    assert.match(await res.text(), /expired or was already used/);
  }

  // Replaying a callback that already worked: its state is used up.
  const done = await signIn({ sub: "g-replay", email: "replay@example.com", name: "Replay Person" });
  assert.match(done.session, SESSION);
  const afterFirst = google.tokenCalls.length;
  const replay = await callback(done.callbackUrl, done.cookie);
  assert.equal(replay.status, 400);
  assert.equal(replay.headers.get("location"), null);
  assert.match(await replay.text(), /expired or was already used/);
  assert.equal(google.tokenCalls.length, afterFirst, "a replayed state never reaches Google");

  // Someone sends the callback link to a browser that didn't start the sign-in (login CSRF):
  // without the state cookie, or with a different one, it goes back with an error.
  const start = await startSignIn(APP);
  const link = await consent(start.location, { sub: "g-csrf", email: "csrf@example.com", name: "Someone Else" });
  const noCookie = await callback(link, undefined);
  assert.equal(noCookie.status, 302);
  assert.equal(noCookie.headers.get("location"), `${APP}/#ks_error=state`);
  const stillUsedUp = await callback(link, start.cookie);
  assert.equal(stillUsedUp.status, 400, "the failed attempt used the state up");
  await stillUsedUp.text();

  const other = await startSignIn(APP);
  const otherLink = await consent(other.location, { sub: "g-csrf", email: "csrf@example.com", name: "Someone Else" });
  const wrongCookie = await callback(otherLink, (await startSignIn(APP)).cookie);
  assert.equal(wrongCookie.headers.get("location"), `${APP}/#ks_error=state`);
  assert.equal(google.tokenCalls.length, afterFirst, "no code was exchanged");

  // A state older than 10 minutes.
  const slow = await startSignIn(APP);
  const slowLink = await consent(slow.location, { sub: "g-slow", email: "slow@example.com", name: "Slow Person" });
  const stateHash = createHash("sha256").update(slow.state).digest("hex");
  await d1(`UPDATE oauth_states SET expires_at = '2000-01-01T00:00:00.000Z' WHERE state_hash = '${stateHash}'`);
  const expired = await callback(slowLink, slow.cookie);
  assert.equal(expired.headers.get("location"), `${APP}/#ks_error=expired`);

  // The person clicks Cancel at Google.
  const cancelled = await signIn({ deny: true }, { returnOrigin: APP });
  assert.equal(cancelled.location, `${APP}/#ks_error=cancelled`);
  assert.equal(google.tokenCalls.length, afterFirst);
  assert.ok(exchanges < afterFirst);
});

test("an id_token with the wrong nonce, audience or issuer, or an expired one, is refused", async () => {
  const now = Math.floor(Date.now() / 1000);
  const cases = {
    nonce: { nonce: "not-the-nonce-the-gateway-sent" },
    aud: { aud: "someone-else.apps.googleusercontent.com" },
    azp: { aud: [GOOGLE_CLIENT_ID, "someone-else.apps.googleusercontent.com"], azp: "someone-else.apps.googleusercontent.com" },
    iss: { iss: "https://accounts.google.com.evil.example" },
    exp: { exp: now - 3600 },
    sub: { sub: "" },
  };
  for (const [what, claims] of Object.entries(cases)) {
    const result = await signIn({ sub: `g-bad-${what}`, email: `bad-${what}@example.com`, name: "Bad Token", claims }, { returnOrigin: APP });
    assert.equal(google.lastTokenCall().status, 200, `${what}: Google answered`);
    assert.equal(result.location, `${APP}/#ks_error=id_token`, what);
    assert.equal(result.session, null);
  }
  const [{ n }] = await d1("SELECT COUNT(*) AS n FROM users WHERE google_sub LIKE 'g-bad-%' OR email LIKE 'bad-%'");
  assert.equal(n, 0, "no account was created");

  // Both issuer spellings Google uses are accepted.
  const plain = await signIn({ sub: "g-plain-iss", email: "plain.iss@example.com", name: "Plain Issuer", claims: { iss: "accounts.google.com" } });
  assert.match(plain.session, SESSION);
});

test("an email pre-grant is claimed on the first sign-in only when Google says the email is verified", async () => {
  // An apostrophe is legal in an email address, and has to survive the SQL and the shell.
  const email = "pre.o'granted@example.com";
  await grantLocally("Pre.O'Granted@Example.com", "5k");

  const unverified = await signIn({ sub: "g-pre-unverified", email, email_verified: false, name: "Not Verified" });
  const u = await me(unverified.session);
  assert.equal(u.allowance, 0, "an unverified email doesn't claim the grant");
  assert.equal(u.email, null, "an unverified email isn't stored");

  const verified = await signIn({ sub: "g-pre-verified", email: "PRE.O'GRANTED@example.com", email_verified: true, name: "Pre Granted" });
  const v = await me(verified.session);
  assert.equal(v.allowance, 5000);
  assert.equal(v.limits.monthlyOutputTokens, 5000);
  assert.equal(v.email, email);
  assert.equal((await me(unverified.session)).allowance, 0);

  const rows = await d1(`SELECT google_sub, allowance FROM users WHERE email = ${sqlString(email)} OR google_sub = 'g-pre-unverified' ORDER BY id`);
  assert.deepEqual(rows, [
    { google_sub: "g-pre-verified", allowance: 5000 },
    { google_sub: "g-pre-unverified", allowance: 0 },
  ]);
});

test("a grant through grant.mjs's local command lets a signed-in account stream, metered against its allowance", async () => {
  const { session } = await signIn({ sub: "g-grant", email: "grant.me@example.com", email_verified: true, name: "Grant Me" }, { returnOrigin: APP });
  await expectError(await post(session, request({ stream: true })), 403, "permission_error");

  const { remote } = await grantLocally("grant.me@example.com", "40");
  assert.ok(remote.startsWith(`npx wrangler d1 execute DB --command "UPDATE users SET allowance = 40 WHERE email = 'grant.me@example.com'; `), remote);
  const granted = await waitFor(async () => {
    const info = await me(session);
    return info.allowance === 40 ? info : null;
  }, "the grant to apply");
  assert.deepEqual(granted.limits, { dailyRequests: 300, monthlyOutputTokens: 40, maxTokens: CAP, models: DEFAULT_MODELS });

  const res = await post(session, request({ stream: true }), { auth: "bearer" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/event-stream/);
  const text = await res.text();
  const call = mock.lastCall();
  assert.equal(text, call.sent);
  assert.equal(call.headers["x-api-key"], OWNER_KEY);
  assert.equal(call.headers.authorization, undefined);
  assert.ok(!JSON.stringify(call.headers).includes(session), "the session is not forwarded");

  // 15 output tokens a response: 15, 30, 45 >= 40, then the limit.
  for (let n = 1; n <= 3; n++) {
    if (n > 1) {
      const next = await post(session, request({ stream: true }));
      assert.equal(next.status, 200);
      await next.text();
    }
    await waitFor(async () => (await me(session)).usage.thisMonth.outputTokens === MOCK_STREAM_USAGE.output_tokens * n, `response ${n} to be metered`);
  }
  const over = await post(session, request({ stream: true }));
  const error = await expectError(over, 429, "rate_limit_error");
  assert.match(error.error.message, /^This account's monthly output token limit is used up \(40 tokens\)\./);
  assert.equal(over.headers.get("x-should-retry"), "false");
  assert.equal((await me(session)).usage.today.requests, 3);

  // Metered under the account's own keys, which can't collide with an invite's hash.
  const [{ id }] = await d1("SELECT id FROM users WHERE google_sub = 'g-grant'");
  const month = new Date().toISOString().slice(0, 7);
  assert.ok((await usageKeys(`tok:user:${id}:`)).includes(`tok:user:${id}:${month}`));

  // Revoking takes effect on the next request.
  await grantLocally("revoke", "grant.me@example.com");
  await waitFor(async () => (await me(session)).allowance === 0, "the revoke to apply");
  const revoked = await expectError(await post(session, request()), 403, "permission_error");
  assert.equal(revoked.error.message, "This account has no Komposit allowance yet.");
});

test("signing out ends that session, and an expired or unknown session is refused", async () => {
  const person = { sub: "g-logout", email: "log.out@example.com", name: "Log Out" };
  const one = await signIn(person);
  const two = await signIn(person);
  assert.equal((await me(one.session)).kind, "account");

  const out = await fetch(`${gateway}/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${one.session}`, origin: APP } });
  assert.equal(out.status, 204);
  assert.equal(out.headers.get("access-control-allow-origin"), APP);
  const after = await expectError(await fetch(`${gateway}/v1/me`, { headers: { "x-api-key": one.session } }), 401, "authentication_error");
  assert.equal(after.error.message, "This sign-in is no longer valid. Sign in again.");
  await expectError(await post(one.session, request()), 401, "authentication_error");
  assert.equal((await me(two.session)).kind, "account", "other sessions of the account keep working");

  // Signing out twice is fine; signing out without a session is not.
  assert.equal((await fetch(`${gateway}/auth/logout`, { method: "POST", headers: { "x-api-key": one.session } })).status, 204);
  await expectError(await fetch(`${gateway}/auth/logout`, { method: "POST" }), 401, "authentication_error");
  await expectError(await fetch(`${gateway}/auth/logout`, { method: "POST", headers: { "x-api-key": codes.main } }), 401, "authentication_error");

  // A session past its 30 days, a made-up one, and a malformed one.
  for (const session of [SEEDED.expired.session, sessionToken(), "ks_short"]) {
    const res = await fetch(`${gateway}/v1/me`, { headers: { "x-api-key": session } });
    assert.equal((await expectError(res, 401, "authentication_error")).error.message, "This sign-in is no longer valid. Sign in again.");
  }
  const [{ n }] = await waitFor(async () => {
    const rows = await d1(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = ${SEEDED.expired.id}`);
    return rows[0].n === 0 ? rows : null;
  }, "the expired session to be cleaned up", 15_000, 500);
  assert.equal(n, 0);
});

test("DELETE /v1/me deletes the account, all its sessions and its usage counters", async () => {
  const person = { sub: "g-delete", email: "delete.me@example.com", email_verified: true, name: "Delete Me" };
  await grantLocally(person.email, "1000");
  const one = await signIn(person);
  const two = await signIn(person);
  const res = await post(one.session, request({ stream: true }));
  assert.equal(res.status, 200);
  await res.text();
  await waitFor(async () => {
    const info = await me(one.session);
    return info.usage.thisMonth.outputTokens > 0 && info.usage.today.requests === 1;
  }, "usage to be recorded");
  const [[{ id }], keys] = await Promise.all([d1("SELECT id FROM users WHERE google_sub = 'g-delete'"), usageKeys("")]);
  const counters = keys.filter((key) => key.includes(`:user:${id}:`));
  assert.equal(counters.length, 2, `a request counter and a token counter: ${counters}`);

  // An invite can't be deleted this way.
  await expectError(await fetch(`${gateway}/v1/me`, { method: "DELETE", headers: { "x-api-key": codes.main } }), 403, "permission_error");

  const del = await fetch(`${gateway}/v1/me`, { method: "DELETE", headers: { "x-api-key": one.session, origin: APP } });
  assert.equal(del.status, 204);
  assert.equal(del.headers.get("access-control-allow-origin"), APP);
  for (const session of [one.session, two.session]) {
    await expectError(await fetch(`${gateway}/v1/me`, { headers: { "x-api-key": session } }), 401, "authentication_error");
  }
  const [[left], keysAfter] = await Promise.all([
    d1(
      `SELECT (SELECT COUNT(*) FROM users WHERE id = ${id} OR google_sub = 'g-delete' OR email = 'delete.me@example.com') AS users, ` +
        `(SELECT COUNT(*) FROM sessions WHERE user_id = ${id}) AS sessions`,
    ),
    usageKeys(""),
  ]);
  assert.deepEqual(left, { users: 0, sessions: 0 });
  assert.deepEqual(keysAfter.filter((key) => key.includes(`:user:${id}:`)), []);

  // Signing in again starts from nothing: a new account with no allowance and no usage.
  const fresh = await signIn(person);
  const info = await me(fresh.session);
  assert.equal(info.allowance, 0);
  assert.equal(info.usage.thisMonth.outputTokens, 0);
  const [{ id: newId }] = await d1("SELECT id FROM users WHERE google_sub = 'g-delete'");
  assert.ok(newId > id, "ids are never reused");
});

test("CORS: the app's pages get a working preflight and readable responses; other origins get no CORS headers", async () => {
  // The headers the browser SDK sends, read off a request that never leaves this process.
  let sent;
  const probe = new Anthropic({
    baseURL: gateway,
    apiKey: SEEDED.browser.session,
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    fetch: async (url, init) => {
      sent = new Headers(init.headers);
      throw new Error("probe only");
    },
  });
  await assert.rejects(probe.messages.create({ model: "claude-haiku-5-5", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }));
  // What a browser lists in Access-Control-Request-Headers: every header that isn't CORS-safelisted.
  const requested = [...sent.keys()].filter((name) => !["accept", "user-agent"].includes(name)).sort().join(",");
  for (const name of ["anthropic-dangerous-direct-browser-access", "anthropic-version", "authorization", "content-type", "x-stainless-lang"]) {
    assert.ok(requested.split(",").includes(name), `the SDK sends ${name}`);
  }

  for (const origin of [APP, LOCAL_PAGE, "http://localhost:4330"]) {
    const res = await preflight("/v1/messages", origin, "POST", requested);
    assert.equal(res.status, 204, origin);
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
    assert.equal(res.headers.get("access-control-allow-headers"), requested, "the requested headers are echoed");
    assert.equal(res.headers.get("access-control-allow-methods"), "POST");
    assert.ok(Number(res.headers.get("access-control-max-age")) > 0);
    assert.match(res.headers.get("vary"), /\bOrigin\b/);
    assert.equal(res.headers.get("access-control-allow-credentials"), null, "no cookies are involved");
  }
  for (const [route, method, allowed] of [["/v1/me", "GET", "GET, DELETE"], ["/v1/me", "DELETE", "GET, DELETE"], ["/auth/logout", "POST", "POST"]]) {
    const res = await preflight(route, APP, method, "authorization");
    assert.equal(res.status, 204, `${method} ${route}`);
    assert.equal(res.headers.get("access-control-allow-methods"), allowed);
  }
  const wrongMethod = await preflight("/v1/me", APP, "PUT", "authorization");
  assert.equal(wrongMethod.status, 404);
  assert.deepEqual(corsHeaders(wrongMethod), []);

  // The real thing, as the browser SDK on the app's page makes it, with a session.
  let responseHeaders;
  const browser = new Anthropic({
    baseURL: gateway,
    apiKey: SEEDED.browser.session,
    dangerouslyAllowBrowser: true,
    defaultHeaders: { origin: APP },
    fetch: async (url, init) => {
      const res = await fetch(url, init);
      responseHeaders = res.headers;
      return res;
    },
  });
  const message = await browser.messages
    .stream({ model: "claude-haiku-5-5", max_tokens: 64, messages: [{ role: "user", content: "Say hello" }] })
    .finalMessage();
  assert.equal(message.content[0].text, MOCK_TEXT);
  assert.equal(responseHeaders.get("access-control-allow-origin"), APP);
  assert.match(responseHeaders.get("access-control-expose-headers"), /request-id/);
  assert.match(responseHeaders.get("access-control-expose-headers"), /retry-after/);
  assert.match(responseHeaders.get("vary"), /\bOrigin\b/);
  const call = mock.lastCall();
  assert.equal(call.headers["x-api-key"], OWNER_KEY);
  assert.equal(call.headers["anthropic-dangerous-direct-browser-access"], undefined, "browser-only headers stay in the gateway");
  assert.equal(call.headers.origin, undefined);

  // Errors carry the CORS headers too, or the page couldn't read them.
  const denied = await fetch(`${gateway}/v1/messages`, {
    method: "POST",
    headers: { origin: APP, "content-type": "application/json", "x-api-key": sessionToken() },
    body: JSON.stringify(request()),
  });
  await expectError(denied, 401, "authentication_error");
  assert.equal(denied.headers.get("access-control-allow-origin"), APP);
  const meRes = await fetch(`${gateway}/v1/me`, { headers: { origin: LOCAL_PAGE, authorization: `Bearer ${SEEDED.browser.session}` } });
  assert.equal(meRes.status, 200);
  assert.equal(meRes.headers.get("access-control-allow-origin"), LOCAL_PAGE);
  assert.equal(meRes.headers.get("cache-control"), "no-store");
  assert.equal((await meRes.json()).email, SEEDED.browser.email);

  // Any other origin: no CORS headers at all, on the preflight or the response.
  for (const origin of ["https://evil.example", "null", "https://app.komposit.werq.dev.evil.example", "http://127.0.0.1:4331"]) {
    const pre = await preflight("/v1/messages", origin, "POST", requested);
    assert.equal(pre.status, 404, origin);
    assert.deepEqual(corsHeaders(pre), [], origin);
    const res = await post(codes.main, request(), { headers: { origin } });
    assert.equal(res.status, 200);
    await res.json();
    assert.deepEqual(corsHeaders(res), [], origin);
  }
  // Routes without CORS stay that way, even for the app's origin.
  const health = await fetch(`${gateway}/health`, { headers: { origin: APP } });
  assert.deepEqual(corsHeaders(health), []);
  await health.json();
});

test("sign-in stays off until the client id (not the placeholder), the secret and D1 are all there", () => {
  const ready = { GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "secret", DB: {} };
  assert.equal(signInConfig(ready).ready, true);
  assert.equal(signInConfig(ready).authUrl, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(signInConfig(ready).tokenUrl, "https://oauth2.googleapis.com/token");
  assert.deepEqual(signInConfig({ ...ready, GOOGLE_CLIENT_ID: "TODO-replace-with-google-oauth-client-id" }).missing, ["GOOGLE_CLIENT_ID"]);
  assert.deepEqual(signInConfig({}).missing, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "DB"]);
  // The id_token's signature isn't checked, so the token endpoint must be https (plain http only to this machine).
  assert.deepEqual(signInConfig({ ...ready, GOOGLE_TOKEN_URL: "http://oauth2.googleapis.com/token" }).missing, ["GOOGLE_TOKEN_URL"]);
  assert.deepEqual(signInConfig({ ...ready, GOOGLE_AUTH_URL: "ftp://accounts.google.com/" }).missing, ["GOOGLE_AUTH_URL"]);
  assert.equal(signInConfig({ ...ready, GOOGLE_TOKEN_URL: "http://127.0.0.1:9/token" }).ready, true);
});

test("readIdToken checks the claims and keeps only a verified, lowercased email", () => {
  const now = Date.now();
  const token = (claims) => ["eyJhbGciOiJSUzI1NiJ9", Buffer.from(JSON.stringify(claims)).toString("base64url"), "c2ln"].join(".");
  const good = { iss: "https://accounts.google.com", aud: "client", sub: "123", nonce: "n0", exp: now / 1000 + 60, email: " Jo@Example.COM ", email_verified: "true", name: " Jo " };
  const read = (claims, nonce = "n0") => readIdToken(token(claims), { clientId: "client", nonce, now });
  assert.deepEqual(read(good), { sub: "123", email: "jo@example.com", name: "Jo" });
  assert.deepEqual(read({ ...good, email_verified: false }), { sub: "123", email: null, name: "Jo" });
  assert.deepEqual(read({ ...good, name: undefined }), { sub: "123", email: "jo@example.com", name: null });
  assert.deepEqual(read({ ...good, aud: ["client"] }).sub, "123", "an audience list with only this client needs no azp");
  assert.deepEqual(read({ ...good, exp: now / 1000 - 60 }).sub, "123", "two minutes of clock skew are allowed");
  assert.deepEqual(read({ ...good, exp: now / 1000 - 600 }), { error: "exp" });
  assert.deepEqual(read({ ...good, exp: "never" }), { error: "exp" });
  assert.deepEqual(read({ ...good, azp: "other" }), { error: "azp" });
  assert.deepEqual(read({ ...good, aud: undefined }), { error: "aud" });
  assert.deepEqual(read(good, "n1"), { error: "nonce" });
  assert.deepEqual(read({ ...good, nonce: undefined }), { error: "nonce" });
  assert.deepEqual(read({ ...good, sub: 123 }), { error: "sub" });
  for (const bad of [undefined, "", "a.b", "a.b.c", `x.${Buffer.from("[1]").toString("base64url")}.y`, "x".repeat(20000)]) {
    assert.ok(readIdToken(bad, { clientId: "client", nonce: "n0", now }).error, String(bad).slice(0, 20));
  }
});

test("grant.mjs's helpers normalize emails, parse allowances and quote SQL", () => {
  assert.equal(normalizeEmail("  Jane.Doe@Example.COM "), "jane.doe@example.com");
  for (const bad of ["not an email", "a@b", "x@y.z'; DROP TABLE users; --", "@example.com", "a@-example.com", ""]) {
    assert.throws(() => normalizeEmail(bad), /doesn't look like an email address/, bad);
  }
  assert.equal(parseAllowance("2000000"), 2_000_000);
  assert.equal(parseAllowance("2_000_000"), 2_000_000);
  assert.equal(parseAllowance("2,000,000"), 2_000_000);
  assert.equal(parseAllowance("2m"), 2_000_000);
  assert.equal(parseAllowance("1.5k"), 1500);
  assert.equal(parseAllowance("0"), 0);
  for (const bad of ["-1", "lots", "1e9", "", "2 m"]) assert.throws(() => parseAllowance(bad), /whole number/, bad);

  assert.equal(sqlString("o'brien@example.com"), "'o''brien@example.com'");
  assert.equal(
    grantSql("O'Brien@Example.com", "1k").split("; ")[0],
    "UPDATE users SET allowance = 1000 WHERE email = 'o''brien@example.com'",
  );
  assert.match(revokeSql("a@example.com"), /^UPDATE users SET allowance = 0 WHERE email = 'a@example\.com'; SELECT /);
  assert.match(listSql(), /^SELECT .* FROM users u ORDER BY u\.id$/);
  assert.deepEqual(d1Args("SELECT 1", "local"), ["d1", "execute", "DB", "--command", "SELECT 1", "--local"]);
  assert.throws(() => d1Args("SELECT 1", "production"));
  // Double quotes when the shell leaves the text alone; single quotes otherwise.
  assert.equal(grantShellQuote("SELECT 'a'"), `"SELECT 'a'"`);
  assert.equal(grantShellQuote("SELECT '$HOME'"), `'SELECT '\\''$HOME'\\'''`);
});

test("grant.mjs list runs against the local D1 with --run local", async () => {
  const { stdout } = await execFileAsync(process.execPath, [GRANT, "list", "--run", "local", "--persist-to", persistDir], {
    cwd: GATEWAY_DIR,
    env: wranglerEnv(),
  });
  assert.match(stdout, /grant\.me@example\.com/);
  assert.match(stdout, /browser\.tester@example\.com/);
});

test("the Worker's logs never contain invite codes, the owner key, or request/response bodies", () => {
  assert.match(workerOutput, /"evt":"messages"/, "sanity check: the Worker's log lines were captured");
  for (const [name, code] of Object.entries({ ...codes, minted: mintedCode })) {
    if (code) assert.ok(!workerOutput.includes(code), `the ${name} invite code appears in the logs`);
  }
  assert.ok(!workerOutput.includes(OWNER_KEY), "the owner key appears in the logs");
  assert.ok(!workerOutput.includes(BODY_MARKER), "a request body appears in the logs");
  assert.ok(!workerOutput.includes("Say hello"), "a request body appears in the logs");
  assert.ok(!workerOutput.includes("the mock"), "a response body appears in the logs");
});

test("the Worker's logs never contain sessions, OAuth codes, states, tokens, the client secret, emails or names", () => {
  assert.match(workerOutput, /"evt":"sign_in"/, "sanity check: sign-in log lines were captured");
  assert.match(workerOutput, /"account":\d+/, "accounts are logged by id");
  for (const call of google.tokenCalls) {
    signInSecrets.add(call.params.code).add(call.params.code_verifier).add(call.idToken);
  }
  for (const { params } of google.authorizeCalls) signInSecrets.add(params.state).add(params.nonce).add(params.code_challenge);
  signInSecrets.add(GOOGLE_CLIENT_SECRET);
  signInSecrets.delete(undefined);
  signInSecrets.delete(null);
  assert.ok(signInSecrets.size > 40, "sanity check: the secrets were collected");
  for (const secret of signInSecrets) assert.ok(!workerOutput.includes(secret), `a sign-in secret appears in the logs: ${secret.slice(0, 12)}...`);
  const lower = workerOutput.toLowerCase();
  for (const item of personalData) assert.ok(!lower.includes(item.toLowerCase()), `"${item}" appears in the logs`);
});

// ---------------------------------------------------------------------------

function request(overrides = {}) {
  return {
    model: "claude-opus-5-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Say hello" }],
    ...overrides,
  };
}

function post(code, body, { auth = "x-api-key", headers = {}, query = "", signal } = {}) {
  const all = { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers };
  if (code !== undefined) {
    if (auth === "bearer") all.authorization = `Bearer ${code}`;
    else all["x-api-key"] = code;
  }
  return fetch(`${gateway}/v1/messages${query}`, {
    method: "POST",
    headers: all,
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });
}

async function me(code) {
  const res = await fetch(`${gateway}/v1/me`, { headers: { "x-api-key": code } });
  assert.equal(res.status, 200);
  return res.json();
}

// --- Sign-in: the test plays the browser, and mock-google.mjs plays Google.

/** GET /auth/google/start like a browser: returns Google's authorize URL and the state cookie. */
async function startSignIn(returnOrigin = LOCAL_PAGE) {
  const res = await fetch(`${gateway}/auth/google/start?return=${encodeURIComponent(returnOrigin)}`, { redirect: "manual" });
  assert.equal(res.status, 302, `start with return=${returnOrigin}`);
  const location = new URL(res.headers.get("location"));
  const state = location.searchParams.get("state");
  signInSecrets.add(state);
  return { res, location, state, cookie: res.headers.get("set-cookie").split(";")[0] };
}

/** The person picks a Google account (or cancels); returns the callback URL Google sends the browser to. */
async function consent(authorizeUrl, who) {
  const url = new URL(authorizeUrl);
  url.searchParams.set("mock_identity", Buffer.from(JSON.stringify(who)).toString("base64url"));
  for (const item of [who.email, who.name, who.sub]) if (item) personalData.add(item);
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 302, `Google refused the authorize URL: ${await res.text()}`);
  const callbackUrl = res.headers.get("location");
  const code = new URL(callbackUrl).searchParams.get("code");
  if (code) signInSecrets.add(code);
  return callbackUrl;
}

function callback(callbackUrl, cookie) {
  return fetch(callbackUrl, { redirect: "manual", headers: cookie ? { cookie } : {} });
}

/** A whole sign-in. Returns the callback's response, where it sent the browser, and the session or error. */
async function signIn(who, { returnOrigin = LOCAL_PAGE } = {}) {
  const start = await startSignIn(returnOrigin);
  const callbackUrl = await consent(start.location, who);
  const res = await callback(callbackUrl, start.cookie);
  const location = res.headers.get("location");
  const fragment = new URLSearchParams(location ? new URL(location).hash.slice(1) : "");
  const session = fragment.get("ks");
  if (session) signInSecrets.add(session);
  return { res, location, session, error: fragment.get("ks_error"), callbackUrl, cookie: start.cookie };
}

function sessionToken() {
  const base32 = "abcdefghijklmnopqrstuvwxyz234567";
  return `ks_${Array.from(randomBytes(52), (byte) => base32[byte & 31]).join("")}`;
}

/** SQL for the SEEDED accounts and their sessions (only the sessions' hashes are stored). */
function seedAccountsSql() {
  const created = "2026-01-01T00:00:00.000Z";
  const accounts = Object.values(SEEDED);
  const users = accounts.map(
    (a) => `(${a.id}, ${sqlString(a.sub)}, ${sqlString(a.email)}, ${sqlString(a.name)}, '${created}', ${a.allowance})`,
  );
  const sessions = accounts.map((a) => {
    const hash = createHash("sha256").update(a.session).digest("hex");
    const [made, expires] = a.expired ? ["2000-01-01T00:00:00.000Z", "2000-01-31T00:00:00.000Z"] : [created, "2099-01-01T00:00:00.000Z"];
    return `('${hash}', ${a.id}, '${made}', '${expires}')`;
  });
  return (
    `INSERT INTO users (id, google_sub, email, name, created_at, allowance) VALUES ${users.join(", ")};\n` +
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ${sessions.join(", ")};\n`
  );
}

/** Run grant.mjs, then run the --local command it prints exactly as printed, against this test's D1. */
async function grantLocally(...args) {
  const { stdout } = await execFileAsync(process.execPath, [GRANT, ...args], { cwd: GATEWAY_DIR });
  const lines = stdout.split("\n").map((line) => line.trim());
  const remote = lines.find((line) => line.startsWith("npx wrangler d1 execute DB") && line.endsWith("--remote"));
  const local = lines.find((line) => line.startsWith("npx wrangler d1 execute DB") && line.endsWith("--local"));
  assert.ok(remote, "prints the --remote command");
  assert.ok(local, "prints the --local command");
  await execFileAsync("/bin/sh", ["-c", `${local} --persist-to ${shellQuote(persistDir)}`], {
    cwd: GATEWAY_DIR,
    env: wranglerEnv(),
  });
  return { stdout, remote, local };
}

/** Query this test's local D1; returns the rows of the last statement. */
async function d1(sql) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [WRANGLER, "d1", "execute", "DB", "--local", "--persist-to", persistDir, "--json", "--command", sql],
    { cwd: GATEWAY_DIR, env: wranglerEnv() },
  );
  const results = JSON.parse(stdout);
  return results[results.length - 1].results;
}

/** The names of this test's local USAGE keys, optionally under a prefix. */
async function usageKeys(prefix) {
  const args = [WRANGLER, "kv", "key", "list", "--binding", "USAGE", "--local", "--persist-to", persistDir];
  if (prefix) args.push("--prefix", prefix);
  const { stdout } = await execFileAsync(process.execPath, args, { cwd: GATEWAY_DIR, env: wranglerEnv() });
  return JSON.parse(stdout).map((key) => key.name);
}

/** A CORS preflight as a browser sends it. */
async function preflight(route, origin, method, requestHeaders) {
  const res = await fetch(`${gateway}${route}`, {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": method, "access-control-request-headers": requestHeaders },
  });
  await res.arrayBuffer();
  return res;
}

function corsHeaders(res) {
  return [...res.headers.keys()].filter((name) => name.startsWith("access-control-"));
}

async function expectError(res, status, type) {
  assert.equal(res.status, status);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  const body = await res.json();
  assert.equal(body.type, "error");
  assert.equal(body.error.type, type);
  assert.equal(typeof body.error.message, "string");
  return body;
}

async function waitFor(check, what, timeoutMs = 5000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRunning(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function wranglerEnv() {
  return { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" };
}

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}
