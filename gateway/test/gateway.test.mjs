// End-to-end tests for komposit-gateway.
//
// Starts a mock Anthropic upstream (test/mock-upstream.mjs), seeds a throwaway
// local KV with test invites using `wrangler kv bulk put --local`, runs the Worker
// under `wrangler dev --local` (miniflare: no Cloudflare account, no network) with
// UPSTREAM_BASE pointed at the mock, then drives it over HTTP like a tester would.
//
//   npm test                       from gateway/
//   DEBUG_GATEWAY=1 npm test       also print wrangler dev's output
//   KEEP_TEST_STATE=1 npm test     keep .wrangler/test-state-*/ (the local KV) afterwards
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
import { generateInviteCode, hashInviteCode } from "../scripts/mint-invite.mjs";
import { MOCK_JSON_USAGE, MOCK_STREAM_USAGE, MOCK_TEXT, startMockUpstream } from "./mock-upstream.mjs";

const execFileAsync = promisify(execFile);
const GATEWAY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(GATEWAY_DIR, "node_modules", "wrangler", "bin", "wrangler.js");
const MINT = path.join(GATEWAY_DIR, "scripts", "mint-invite.mjs");

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

    // Seed INVITES the way an operator would: with wrangler, into a fresh local KV.
    const seedFile = path.join(stateDir, "invites.json");
    const entries = Object.entries(INVITES).map(([key, record]) => ({
      key: `inv:${hashInviteCode(codes[key])}`,
      value: JSON.stringify(record),
    }));
    await writeFile(seedFile, JSON.stringify(entries));
    await execFileAsync(
      process.execPath,
      [WRANGLER, "kv", "bulk", "put", seedFile, "--binding", "INVITES", "--local", "--persist-to", persistDir],
      { cwd: GATEWAY_DIR, env: wranglerEnv() },
    );

    const port = await freePort();
    gateway = `http://127.0.0.1:${port}`;
    worker = spawn(
      process.execPath,
      [
        WRANGLER, "dev", "--local",
        "--ip", "127.0.0.1",
        "--port", String(port),
        "--inspector-port", String(await freePort()),
        "--persist-to", persistDir,
        "--show-interactive-dev-session=false",
        // Only the upstream and the secret are test-specific; limits come from wrangler.toml.
        "--var", `UPSTREAM_BASE:${mock.url}`,
        "--var", `ANTHROPIC_API_KEY:${OWNER_KEY}`,
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
  if (stateDir && !process.env.KEEP_TEST_STATE) await rm(stateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

test("GET /health reports a configured gateway", async () => {
  const res = await fetch(`${gateway}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
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
