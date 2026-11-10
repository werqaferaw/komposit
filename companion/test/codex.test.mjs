// The Codex engine (ChatGPT plan): its `codex exec --json` events become the
// same events as the other engines, its command line keeps Komposit's runs to
// Komposit's tools and the person's ChatGPT plan, and status and broken
// installs are explained in plain words. Runs use a fake `codex` (CODEX_PATH)
// that replays recorded streams, so no test needs a real sign-in.
//
// Fixtures (fixtures/codex/), all from codex-cli 0.167.0, with thread ids,
// Cloudflare ray ids and request ids replaced by placeholders:
//   plain, render, resume, edit-render, model-error
//       real runs on a ChatGPT sign-in, low effort, Komposit's arguments, with
//       a stand-in MCP server named komposit (canned edit / render results, no
//       Adobe app); resume continues render's thread.
//   not-signed-in
//       a real run with an empty CODEX_HOME against the real endpoint.
//   reasoning-scripted, tool-error-scripted, usage-limit-scripted
//       the real binary against a local stand-in for the Responses API that
//       scripts the model's replies (reasoning summaries, a tool that fails,
//       the plan's usage limit): paths a short real run can't trigger.
//   resume-missing.stderr.txt
//       the real binary asked to resume a thread that doesn't exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, rmSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures", "codex");
const TMP = mkdtempSync(join(tmpdir(), "komposit-codex-"));
process.env.KOMPOSIT_DATA_DIR = join(TMP, "data"); // before config.mjs loads

const { handleEvent, newContext, codexArgs, codexPlainArgs, lastMessage, reasoningNotes, runCodexTurn, OFF_FEATURES, WORK_DIR } = await import("../engines/codex.mjs");
const { steerFor } = await import("../engines/cli.mjs");
const shellenv = await import("../shellenv.mjs");
const { parseCodexLogin, codexStatus, codexEnv, codexAuthStore, codexInNpm, isBrokenCodex, codexReinstallCommand, isBrokenClaude } = shellenv;
const { nameChat, SYSTEM } = await import("../titles.mjs");

test.after(() => rmSync(TMP, { recursive: true, force: true }));

const PNG_NAVY = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGMQUbQlCTGMahjVMHw1AAB0QnIBlP7A2QAAAABJRU5ErkJggg==";
const PNG_DOT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const lines = (name) => readFileSync(join(FIX, name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Feed a recorded stream through the parser; returns the events and context.
function replay(name, ctxOpts = {}) {
  const events = [];
  const ctx = newContext(ctxOpts);
  const signals = [];
  for (const ev of lines(name)) {
    const r = handleEvent(ev, (e) => events.push(e), ctx);
    if (r) signals.push(r);
  }
  return { events, ctx, signals };
}
// timing depends on the clock: check its shape, then drop it.
function withoutTiming(events) {
  const t = events.filter((e) => e.type === "timing");
  assert.equal(t.length, 1, "one timing event");
  assert.ok(typeof t[0].modelMs === "number" && t[0].modelMs >= 0);
  return events.filter((e) => e.type !== "timing");
}

// ---------- recorded streams -> events ----------

test("a real edit + render turn becomes notes, steps (with the render) and the final message", () => {
  const { events, ctx } = replay("edit-render.jsonl");
  assert.deepEqual(withoutTiming(events), [
    { type: "note", text: "I’ll run the requested edit, then render the artboard." },
    { type: "tool_run", id: "item_1", name: "edit", input: { code: "'ok'", explanation: "Test edit" } },
    { type: "tool_done", id: "item_1", name: "edit", display: "result: ok", image: null, video: null, is_error: false },
    { type: "tool_run", id: "item_2", name: "render", input: {} },
    { type: "tool_done", id: "item_2", name: "render", display: "Rendered artboard 1.", image: { media_type: "image/png", data: PNG_NAVY }, video: null, is_error: false },
    { type: "note", text: "The edit returned “ok,” and artboard 1 rendered successfully." },
    { type: "final", text: "The edit returned “ok,” and artboard 1 rendered successfully." },
  ]);
  assert.equal(ctx.threadId, "00000000-0000-7000-8000-000000000003");
  assert.equal(ctx.completed, true);
});

test("reasoning summaries become short progress notes", () => {
  const { events } = replay("reasoning-scripted.jsonl");
  const inspectText = 'Document: poster.ai (1 artboard, 1080 x 1350 px, RGB)\n[r1] path "Shape 1" fill #F28C28\n[r2] path "Shape 2" fill #F28C28\n[r3] path "Shape 3" fill #F28C28';
  assert.deepEqual(withoutTiming(events), [
    { type: "note", text: "Checking the poster first" },
    { type: "tool_run", id: "item_1", name: "inspect", input: {} },
    { type: "tool_done", id: "item_1", name: "inspect", display: inspectText.slice(0, 200), image: { media_type: "image/png", data: PNG_DOT }, video: null, is_error: false },
    { type: "note", text: "Planning the recolor" },
    { type: "note", text: "I'll swap the orange shapes to navy and coral in one edit." },
    { type: "tool_run", id: "item_4", name: "edit", input: { explanation: "Recolor the three orange shapes to navy and coral", code: "var d = app.activeDocument; 'ok'" } },
    { type: "tool_done", id: "item_4", name: "edit", display: '{"ok":true,"data":"ok","logs":[]}', image: null, video: null, is_error: false },
    { type: "tool_run", id: "item_5", name: "render", input: {} },
    { type: "tool_done", id: "item_5", name: "render", display: "Rendered artboard 1 of poster.ai.", image: { media_type: "image/png", data: PNG_DOT }, video: null, is_error: false },
    { type: "note", text: "Done. The three orange shapes are now navy and coral. Press Cmd+Z in Illustrator to undo." },
    { type: "final", text: "Done. The three orange shapes are now navy and coral. Press Cmd+Z in Illustrator to undo." },
  ]);
});

test("a plain answer, and a resumed thread", () => {
  assert.deepEqual(withoutTiming(replay("plain.jsonl").events), [
    { type: "note", text: "ready" },
    { type: "final", text: "ready" },
  ]);
  const { events, ctx } = replay("resume.jsonl", { resume: "00000000-0000-7000-8000-000000000002" });
  assert.deepEqual(withoutTiming(events), [
    { type: "note", text: "done" },
    { type: "final", text: "done" },
  ]);
  assert.equal(ctx.threadId, "00000000-0000-7000-8000-000000000002", "resume continues render's thread");
  assert.equal(lines("render.jsonl")[0].thread_id, ctx.threadId);
  // Codex started a different thread than the one asked for: said once, up front.
  const other = replay("resume.jsonl", { resume: "00000000-0000-7000-8000-0000000000ff" }).events;
  assert.equal(other[0].type, "note");
  assert.match(other[0].text, /fresh one/);
});

test("a tool that fails is a failed step, with its message", () => {
  const { events } = replay("tool-error-scripted.jsonl");
  const done = events.find((e) => e.type === "tool_done");
  assert.deepEqual(done, { type: "tool_done", id: "item_0", name: "save", display: "save: not available in this stub", image: null, video: null, is_error: true });
});

test("a failed turn becomes one plain error; warnings and retries stay quiet", () => {
  const { events, ctx } = replay("model-error.jsonl");
  assert.deepEqual(events, [
    { type: "error", message: "Codex stopped: The 'komposit-no-such-model' model is not supported when using Codex with a ChatGPT account.", code: "codex_result" },
  ]);
  assert.equal(ctx.failed, true);

  const limit = replay("usage-limit-scripted.jsonl").events;
  assert.deepEqual(limit, [
    { type: "error", message: "Your ChatGPT plan has reached its Codex usage limit for now. Try again later, or pick another AI in Settings.", code: "codex_result" },
  ]);

  // A transient failure gets one quiet note, not one per retry.
  const ctx2 = newContext();
  const ev2 = [];
  for (let i = 2; i <= 5; i++) handleEvent({ type: "error", message: `Reconnecting... ${i}/5 (stream disconnected before completion)` }, (e) => ev2.push(e), ctx2);
  assert.deepEqual(ev2, [{ type: "note", text: "Having trouble reaching ChatGPT, retrying." }]);
});

test("not signed in: the first 401 stops the run (no 20 s of retries)", () => {
  const { events, signals } = replay("not-signed-in.jsonl");
  assert.deepEqual(events, []);
  assert.equal(signals[0], "auth");
  // Any other 401 runs its course (Codex may refresh its token); a turn that
  // still fails on one is reported as a sign-in problem too.
  const ctx = newContext();
  assert.equal(handleEvent({ type: "error", message: "Reconnecting... 2/5 (unexpected status 401 Unauthorized: token expired)" }, () => {}, ctx), undefined);
  assert.equal(handleEvent({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized: token expired" } }, () => {}, ctx), "auth");
});

test("reasoning text without titles falls back to its first paragraph", () => {
  assert.deepEqual(reasoningNotes("**One**\n\nbody\n**Two**\n\nmore"), ["One", "Two"]);
  assert.deepEqual(reasoningNotes("Looking at the *layers* first.\n\nThen more."), ["Looking at the layers first."]);
  assert.deepEqual(reasoningNotes("  "), []);
});

// ---------- the command line ----------

const kv = (args, key) => {
  const i = args.findIndex((a, n) => args[n - 1] === "-c" && a.startsWith(key + "="));
  return i === -1 ? undefined : args[i].slice(key.length + 1);
};

test("a fresh run: Komposit's tools only, no prompts, no writes, the person's config left out", () => {
  const args = codexArgs({ app: "photoshop", effort: "high" });
  assert.deepEqual(args.slice(0, 9), ["exec", "--json", "--ignore-user-config", "--skip-git-repo-check", "--sandbox", "read-only", "--cd", WORK_DIR, "-c"]);
  assert.equal(kv(args, "approval_policy"), '"never"');
  assert.equal(kv(args, "model_reasoning_effort"), '"high"');
  assert.equal(kv(args, "web_search"), '"disabled"');
  assert.equal(kv(args, "project_doc_max_bytes"), "0");
  assert.equal(kv(args, "agents.enabled"), "false");
  assert.equal(kv(args, "mcp_servers.komposit.command"), JSON.stringify(process.execPath));
  const serverArgs = JSON.parse(kv(args, "mcp_servers.komposit.args"));
  assert.match(serverArgs[0], /mcp[\\/]doc-server\.mjs$/);
  assert.deepEqual(serverArgs.slice(1), ["--app", "photoshop"]);
  assert.equal(kv(args, "mcp_servers.komposit.tool_timeout_sec"), "900");
  assert.equal(kv(args, "mcp_servers.komposit.required"), "true");
  assert.equal(kv(args, "mcp_servers.komposit.default_tools_approval_mode"), '"approve"');
  assert.equal(kv(args, "mcp_servers.komposit.omit_tools_from"), '["deferred"]');
  for (const f of [...OFF_FEATURES, "view_image"]) assert.equal(kv(args, `features.${f}`), "false", f);
  assert.equal(JSON.parse(kv(args, "developer_instructions")), steerFor("photoshop"), "the prompt Claude Code gets");
  assert.ok(!args.includes("resume"));
  assert.ok(!args.includes("--disable"), "an unknown --disable key fails the whole run");
  assert.equal(kv(args, "cli_auth_credentials_store"), undefined);
});

test("resume, effort, images, attached files, the sign-in store, the doc server's environment", () => {
  const args = codexArgs({
    app: "illustrator",
    resume: "00000000-0000-7000-8000-000000000002",
    imagePaths: ["/tmp/a.png", "/tmp/b.jpg"],
    withFiles: true,
    authStore: "keyring",
    server: { command: "/node", args: ["/doc.mjs", "--app", "illustrator"], env: { KOMPOSIT_DATA_DIR: "/data", AE_APP: 'Adobe After Effects "Beta"' } },
  });
  const r = args.indexOf("resume");
  assert.ok(r > 0);
  assert.deepEqual(args.slice(r), ["resume", "00000000-0000-7000-8000-000000000002", "--image", "/tmp/a.png", "--image", "/tmp/b.jpg"]);
  assert.ok(args.lastIndexOf("-c") < r, "every -c goes before resume");
  assert.equal(kv(args, "model_reasoning_effort"), undefined, "no effort, Codex's default");
  assert.equal(kv(args, "features.view_image"), undefined, "attached pictures can be looked at");
  assert.equal(kv(args, "cli_auth_credentials_store"), '"keyring"');
  assert.equal(kv(args, "mcp_servers.komposit.env"), '{KOMPOSIT_DATA_DIR = "/data", AE_APP = "Adobe After Effects \\"Beta\\""}');
});

test("the prompt survives TOML quoting: quotes, backslashes, newlines, control characters", () => {
  const steer = 'Use "refs".\nC:\\Users\\x\tend\u0001\u007f';
  const v = kv(codexArgs({ steer }), "developer_instructions");
  assert.ok(!/[\n\t\u0000-\u001f\u007f]/.test(v), "nothing raw that TOML rejects");
  assert.equal(JSON.parse(v), steer);
});

test("chat titles run with no tools and keep nothing", () => {
  const args = codexPlainArgs({ instructions: SYSTEM });
  assert.ok(args.includes("--ephemeral") && args.includes("--ignore-user-config"));
  assert.ok(!args.some((a) => a.startsWith("mcp_servers.")));
  assert.equal(kv(args, "model_reasoning_effort"), '"low"');
  assert.equal(kv(args, "features.shell_tool"), "false");
  assert.equal(JSON.parse(kv(args, "developer_instructions")), SYSTEM);
  assert.equal(lastMessage(readFileSync(join(FIX, "edit-render.jsonl"), "utf8")), "The edit returned “ok,” and artboard 1 rendered successfully.");
});

test("subscription billing only: keys and endpoint overrides never reach Codex", () => {
  const env = codexEnv({ PATH: "/bin", CODEX_HOME: "/h", OPENAI_API_KEY: "sk-x", CODEX_API_KEY: "sk-y", CODEX_ACCESS_TOKEN: "t", OPENAI_BASE_URL: "http://x", openai_api_key: "sk-z" });
  assert.deepEqual(env, { PATH: "/bin", CODEX_HOME: "/h" });
});

// ---------- status ----------

test("login status: ChatGPT, API key, not signed in", () => {
  // Real output of `codex login status` (stderr), codex-cli 0.167.0.
  assert.deepEqual(parseCodexLogin("Logged in using ChatGPT\n"), { loggedIn: true, authMethod: "chatgpt" });
  assert.deepEqual(parseCodexLogin("API key configured - sk-proj-***abcde\nAuthentication is checked when you send a request.\n"), { loggedIn: true, authMethod: "api-key" });
  assert.deepEqual(parseCodexLogin("Logged in using an API key - sk-***abc\n"), { loggedIn: true, authMethod: "api-key" }); // older releases
  assert.deepEqual(parseCodexLogin("Not logged in\n"), { loggedIn: false, authMethod: null });
  assert.equal(parseCodexLogin("Error checking login status: boom"), null);
});

test("where the sign-in is kept, from the person's config.toml", () => {
  const home = join(TMP, "codex-home");
  mkdirSync(home, { recursive: true });
  assert.equal(codexAuthStore(home), null, "no config.toml");
  writeFileSync(join(home, "config.toml"), 'model = "x"\ncli_auth_credentials_store = "keyring" # mine\n[mcp_servers.a]\ncommand = "a"\n');
  assert.equal(codexAuthStore(home), "keyring");
  writeFileSync(join(home, "config.toml"), '[profiles.a]\ncli_auth_credentials_store = "keyring"\n');
  assert.equal(codexAuthStore(home), null, "only the top-level setting counts");
});

test("Windows: the native codex.exe inside npm's package, since codex.cmd can't be spawned", () => {
  const prefix = join(TMP, "npm");
  const nested = join(prefix, "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin");
  mkdirSync(nested, { recursive: true });
  assert.equal(codexInNpm(prefix, { os: "win32", arch: "x64" }), null, "no exe yet");
  writeFileSync(join(nested, "codex.exe"), "");
  assert.equal(codexInNpm(prefix, { os: "win32", arch: "x64" }), join(nested, "codex.exe"));
  const legacy = join(TMP, "npm-old");
  const old = join(legacy, "node_modules", "@openai", "codex", "vendor", "aarch64-pc-windows-msvc", "codex");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "codex.exe"), "");
  assert.equal(codexInNpm(legacy, { os: "win32", arch: "arm64" }), join(old, "codex.exe"));
  assert.equal(codexInNpm(prefix, { os: "sunos", arch: "x64" }), null);
});

test("a broken install is recognized; isBrokenClaude is unchanged", () => {
  assert.ok(isBrokenCodex(null, "Error: Missing optional dependency @openai/codex-darwin-arm64. Reinstall Codex: npm install -g @openai/codex@latest"));
  assert.ok(isBrokenCodex({ code: "ENOEXEC", message: "spawn ENOEXEC" }));
  assert.ok(!isBrokenCodex(null, "Not logged in"));
  assert.ok(!isBrokenClaude(null, "Missing optional dependency @openai/codex-darwin-arm64"), "Claude's check didn't grow Codex's patterns");
  assert.equal(codexReinstallCommand("/usr/local/bin/codex-not-here"), "npm install -g @openai/codex");
});

// ---------- whole runs through a fake codex ----------

const FAKE = `#!/usr/bin/env node
// A stand-in codex: --version, login status, and exec (records what it was
// given, replays a recorded stream).
const fs = require("fs");
const a = process.argv.slice(2);
const E = process.env;
if (a[0] === "--version") { console.log("codex-cli 0.167.0"); process.exit(0); }
if (a[0] === "login" && a[1] === "status") {
  const m = E.FAKE_CODEX_LOGIN || "chatgpt";
  if (m === "chatgpt") { console.error("Logged in using ChatGPT"); process.exit(0); }
  if (m === "apikey") { console.error("API key configured - sk-proj-***abcde"); console.error("Authentication is checked when you send a request."); process.exit(0); }
  console.error("Not logged in"); process.exit(1);
}
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  const images = a.filter((x, i) => a[i - 1] === "--image").map((p) => ({ p, existed: fs.existsSync(p) }));
  const env = {};
  for (const k of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "CODEX_HOME"]) env[k] = E[k] === undefined ? null : E[k];
  if (E.FAKE_CODEX_LOG) fs.writeFileSync(E.FAKE_CODEX_LOG, JSON.stringify({ args: a, stdin, cwd: process.cwd(), pid: process.pid, env, images }));
  const lines = E.FAKE_CODEX_FIXTURE ? fs.readFileSync(E.FAKE_CODEX_FIXTURE, "utf8").split("\\n").filter(Boolean) : [];
  if (E.FAKE_CODEX_STDERR) process.stderr.write(fs.readFileSync(E.FAKE_CODEX_STDERR, "utf8"));
  const hang = Number(E.FAKE_CODEX_HANG_AFTER || 0);
  for (const l of hang ? lines.slice(0, hang) : lines) process.stdout.write(l + "\\n");
  if (hang) setInterval(() => {}, 1000);
  else process.exitCode = Number(E.FAKE_CODEX_EXIT || 0);
});
`;

const unix = { skip: process.platform === "win32" };
function fakeCodex() {
  const p = join(TMP, "bin", "codex");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, FAKE);
  chmodSync(p, 0o755);
  return p;
}
const FAKE_KEYS = ["FAKE_CODEX_LOGIN", "FAKE_CODEX_LOG", "FAKE_CODEX_FIXTURE", "FAKE_CODEX_STDERR", "FAKE_CODEX_HANG_AFTER", "FAKE_CODEX_EXIT", "CODEX_PATH", "OPENAI_API_KEY", "CODEX_API_KEY"];
async function withFake(vars, fn) {
  const saved = Object.fromEntries(FAKE_KEYS.map((k) => [k, process.env[k]]));
  const log = join(TMP, `log-${Math.random().toString(36).slice(2)}.json`);
  Object.assign(process.env, { CODEX_PATH: fakeCodex(), FAKE_CODEX_LOG: log }, vars);
  try {
    await codexStatus({ fresh: true }); // reset the 30 s cache for this fake
    return await fn(() => (existsSync(log) ? JSON.parse(readFileSync(log, "utf8")) : null));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
async function turn(opts = {}) {
  const events = [];
  const r = await runCodexTurn({ app: "illustrator", userText: "Recolor the logo", emit: (e) => events.push(e), ...opts });
  return { events, r };
}

test("a whole turn: the prompt on stdin, the events, the thread kept for next time", unix, async () => {
  await withFake({ FAKE_CODEX_FIXTURE: join(FIX, "edit-render.jsonl"), OPENAI_API_KEY: "sk-metered", CODEX_API_KEY: "sk-other" }, async (log) => {
    const { events, r } = await turn({ effort: "low", images: [{ media_type: "image/png", data: PNG_NAVY }] });
    assert.deepEqual(r, { sessionId: "00000000-0000-7000-8000-000000000003" });
    assert.deepEqual(events.map((e) => e.type), ["note", "tool_run", "tool_done", "tool_run", "tool_done", "note", "final", "timing"]);
    const l = log();
    assert.equal(l.args[0], "exec");
    assert.match(l.stdin, /^Recolor the logo\n\n\[The user attached a reference image/);
    assert.equal(l.env.OPENAI_API_KEY, null);
    assert.equal(l.env.CODEX_API_KEY, null);
    assert.equal(realpathSync(l.cwd), realpathSync(WORK_DIR));
    assert.equal(l.images.length, 1);
    assert.ok(l.images[0].existed, "the reference image is on disk while Codex runs");
    assert.ok(!existsSync(l.images[0].p), "and removed afterwards");
    assert.equal(kv(l.args, "model_reasoning_effort"), '"low"');
    // The doc server's settings go along (Codex gives MCP servers a bare
    // environment); a developer's .env may add some of them.
    const passed = ["AE_APP", "KOMPOSIT_HELPER", "EXPORT_DIR", "RENDER_MAX_PX"].filter((k) => process.env[k]).map((k) => `, ${k} = ${JSON.stringify(process.env[k])}`).join("");
    assert.equal(kv(l.args, "mcp_servers.komposit.env"), `{KOMPOSIT_DATA_DIR = ${JSON.stringify(join(TMP, "data"))}${passed}}`);
  });
});

test("resume continues the saved thread; a lost thread starts fresh next time", unix, async () => {
  await withFake({ FAKE_CODEX_FIXTURE: join(FIX, "resume.jsonl") }, async (log) => {
    const { events, r } = await turn({ resume: "00000000-0000-7000-8000-000000000002" });
    assert.deepEqual(r, { sessionId: "00000000-0000-7000-8000-000000000002" });
    assert.deepEqual(withoutTiming(events), [{ type: "note", text: "done" }, { type: "final", text: "done" }]);
    const a = log().args;
    assert.deepEqual(a.slice(a.indexOf("resume")), ["resume", "00000000-0000-7000-8000-000000000002"]);
  });
  await withFake({ FAKE_CODEX_STDERR: join(FIX, "resume-missing.stderr.txt"), FAKE_CODEX_EXIT: "1" }, async () => {
    const { events, r } = await turn({ resume: "00000000-0000-7000-8000-000000000009" });
    assert.deepEqual(r, { resumeFailed: true });
    assert.deepEqual(events, [{ type: "error", message: "Couldn't continue the earlier Codex session; your next message starts a fresh one.", code: "codex_resume" }]);
  });
});

test("not signed in, or signed in with an API key: a plain error before anything runs", unix, async () => {
  for (const [login, re] of [["none", /isn't signed in to ChatGPT.*codex login/], ["apikey", /API key, not a ChatGPT plan/]]) {
    await withFake({ FAKE_CODEX_LOGIN: login, FAKE_CODEX_FIXTURE: join(FIX, "plain.jsonl") }, async (log) => {
      const { events, r } = await turn();
      assert.deepEqual(r, {});
      assert.equal(events.length, 1);
      assert.equal(events[0].code, "codex_auth");
      assert.match(events[0].message, re);
      assert.equal(log(), null, "codex exec never ran");
    });
  }
});

test("a sign-in that fails mid-run is stopped at the first 401", { ...unix, timeout: 20000 }, async () => {
  await withFake({ FAKE_CODEX_FIXTURE: join(FIX, "not-signed-in.jsonl"), FAKE_CODEX_HANG_AFTER: "3" }, async (log) => {
    const t0 = Date.now();
    const { events, r } = await turn();
    assert.ok(Date.now() - t0 < 10000, "stopped, not left to hang");
    assert.deepEqual(r, {});
    assert.deepEqual(events.map((e) => e.code), ["codex_auth"]);
    assert.throws(() => process.kill(log().pid, 0), /ESRCH/, "the codex process is gone");
  });
});

test("Stop ends Codex mid-step and keeps the thread", { ...unix, timeout: 20000 }, async () => {
  await withFake({ FAKE_CODEX_FIXTURE: join(FIX, "edit-render.jsonl"), FAKE_CODEX_HANG_AFTER: "4" }, async (log) => {
    const ctl = new AbortController();
    const events = [];
    const run = runCodexTurn({ app: "illustrator", userText: "go", signal: ctl.signal, emit: (e) => { events.push(e); if (e.type === "tool_run") ctl.abort(); } });
    const r = await run;
    assert.deepEqual(r, { sessionId: "00000000-0000-7000-8000-000000000003" });
    assert.deepEqual(events.map((e) => e.type), ["note", "tool_run", "aborted"]);
    assert.throws(() => process.kill(log().pid, 0), /ESRCH/);
  });
});

test("a turn Codex reports as failed is one error", unix, async () => {
  await withFake({ FAKE_CODEX_FIXTURE: join(FIX, "model-error.jsonl"), FAKE_CODEX_EXIT: "1" }, async () => {
    const { events, r } = await turn();
    assert.deepEqual(r, {});
    assert.deepEqual(events.map((e) => e.code), ["codex_result"]);
  });
});

test("a broken install: the turn and the settings check say how to reinstall", unix, async () => {
  const p = join(TMP, "broken", "codex");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, 'echo "not a real program" >&2\nexit 1\n'); // no #! line: ENOEXEC
  chmodSync(p, 0o755);
  const saved = process.env.CODEX_PATH;
  process.env.CODEX_PATH = p;
  try {
    const st = await codexStatus({ fresh: true });
    assert.equal(st.installed, true);
    assert.equal(st.broken, true);
    assert.equal(st.reinstall, "npm install -g @openai/codex");
    const { events } = await turn();
    assert.equal(events[0]?.code, "codex_broken", JSON.stringify(events));
    assert.match(events[0].message, /Reinstall it .*npm install -g @openai\/codex/);
  } finally {
    if (saved === undefined) delete process.env.CODEX_PATH;
    else process.env.CODEX_PATH = saved;
  }
});

test("status through a fake codex: version, ChatGPT plan, API key, signed out", unix, async () => {
  const cases = { chatgpt: { loggedIn: true, authMethod: "chatgpt", usesSubscription: true }, apikey: { loggedIn: true, authMethod: "api-key", usesSubscription: false }, none: { loggedIn: false, authMethod: null, usesSubscription: false } };
  for (const [login, want] of Object.entries(cases)) {
    await withFake({ FAKE_CODEX_LOGIN: login }, async () => {
      const st = await codexStatus({ fresh: true });
      assert.equal(st.installed, true);
      assert.equal(st.version, "0.167.0");
      assert.equal(st.statusKnown, true);
      for (const [k, v] of Object.entries(want)) assert.equal(st[k], v, `${login}: ${k}`);
    });
  }
});

test("chat titles through Codex, and no title (no throw) when it fails", unix, async () => {
  const fixture = join(TMP, "title.jsonl");
  writeFileSync(fixture, ['{"type":"thread.started","thread_id":"00000000-0000-7000-8000-0000000000aa"}', '{"type":"turn.started"}', '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"\\"Bigger navy logo.\\""}}', '{"type":"turn.completed","usage":{}}'].join("\n") + "\n");
  await withFake({ FAKE_CODEX_FIXTURE: fixture }, async (log) => {
    assert.equal(await nameChat({ mode: "codex" }, { text: "make the logo bigger and navy", app: "illustrator" }), "Bigger navy logo");
    const l = log();
    assert.ok(l.args.includes("--ephemeral"));
    assert.ok(!l.args.some((a) => a.startsWith("mcp_servers.")));
    assert.match(l.stdin, /make the logo bigger and navy/);
  });
  await withFake({ FAKE_CODEX_FIXTURE: fixture, FAKE_CODEX_EXIT: "1" }, async () => {
    assert.equal(await nameChat({ mode: "codex" }, { text: "make the logo bigger" }), "");
  });
});
