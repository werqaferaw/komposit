// The Codex engine: the tester's own `codex` (billed to their ChatGPT plan)
// drives the live document through Komposit's MCP tools, the way engines/cli.mjs
// runs Claude Code. Its `codex exec --json` events become the same events the
// other engines emit, so the UI looks the same whichever engine runs.
//
// Checked against codex-cli 0.167.0 (codex-rs/exec, @openai/codex-sdk 0.167.0):
//   - every run gets Komposit's doc server through `-c mcp_servers.komposit.*`
//     and ignores the person's own ~/.codex/config.toml (their MCP servers,
//     model, profiles); the sign-in still comes from ~/.codex;
//   - Codex's own tools (shell, web search, apps, plugins, sub-agents, image
//     generation, browser) are switched off, so only Komposit's tools are left;
//   - the prompt goes in on stdin (no command-line length limit on Windows);
//   - one Codex thread per chat and app, continued with `exec resume <id>`.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { steerFor } from "./cli.mjs";
import { findCodex, codexStatus, userEnv, codexEnv, codexAuthStore, isBrokenCodex, brokenCodexMessage } from "../shellenv.mjs";
import { DATA_DIR } from "../config.mjs";
import platform from "../platform/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = join(HERE, "..", "mcp", "doc-server.mjs");

// Codex keeps its threads in ~/.codex/sessions with the folder they ran in;
// one fixed folder keeps Komposit's together (and out of the person's repos).
export const WORK_DIR = join(DATA_DIR, "codex");

// Codex's built-in tools, off for Komposit runs (feature keys of codex-cli
// 0.167.0, see `codex features list`). As `-c features.<key>=false` rather than
// `--disable <key>`: a key a later Codex drops is then a warning, not a failed
// run (`--disable` with an unknown key fails the run). view_image stays on only
// when files are attached, so Codex can look at an attached picture (like
// Claude Code's Read). Left on, because no setting removes them: apply_patch
// (it can't write in the read-only sandbox) and the MCP resource listing tools.
export const OFF_FEATURES = [
  "shell_tool", "unified_exec", "apps", "plugins", "tool_suggest", "multi_agent",
  "image_generation", "browser_use", "computer_use", "in_app_browser", "goals", "sleep_tool",
];

// Codex gives an MCP call 300 s and a server 30 s to start (0.167.0 defaults);
// an Illustrator PDF export took 313 s in a live test and After Effects
// renders take minutes, and a cold start of the doc server can be slow.
const TOOL_TIMEOUT_SEC = 900;
const STARTUP_TIMEOUT_SEC = 60;

// The environment the doc server needs. Codex starts MCP servers with a small
// fixed set of variables (HOME, PATH, TMPDIR, ...), so these are passed on.
const SERVER_ENV = ["AE_APP", "KOMPOSIT_HELPER", "EXPORT_DIR", "RENDER_MAX_PX"];

// A TOML string for a `-c key=value` override (JSON strings are TOML strings,
// except that TOML wants DEL escaped).
const toml = (s) => JSON.stringify(String(s)).replace(/\u007f/g, "\\u007f");
const tomlList = (a) => `[${a.map(toml).join(", ")}]`;
const tomlTable = (o) => `{${Object.entries(o).map(([k, v]) => `${k} = ${toml(v)}`).join(", ")}}`;

// The arguments for one run. Options that belong to `exec` go before
// `resume <id>`; images go last (after `resume`, they attach to the new
// message). The prompt itself is read from stdin.
export function codexArgs({
  app = "illustrator",
  effort = "",
  resume = null,
  imagePaths = [],
  withFiles = false,
  authStore = null,
  steer = steerFor(app),
  server = { command: process.execPath, args: [MCP_SERVER, "--app", app], env: {} },
} = {}) {
  const c = (kv) => ["-c", kv];
  const off = OFF_FEATURES.concat(withFiles ? [] : ["view_image"]);
  const args = [
    "exec",
    "--json",
    "--ignore-user-config", // not the person's MCP servers, model or profiles
    "--skip-git-repo-check",
    "--sandbox", "read-only", // Codex's own commands may never write
    "--cd", WORK_DIR,
    ...c(`approval_policy="never"`), // never stop to ask
    ...c(`tools.experimental_request_user_input.enabled=false`), // nobody can answer mid-turn
    ...c(`agents.enabled=false`), // no sub-agents
    ...c(`web_search="disabled"`),
    ...c(`project_doc_max_bytes=0`), // no AGENTS.md from folders
    ...c(`skills.include_instructions=false`), // the person's skills stay out of the prompt
    ...c(`skills.bundled.enabled=false`),
    ...c(`developer_instructions=${toml(steer)}`),
    ...c(`mcp_servers.komposit.command=${toml(server.command)}`),
    ...c(`mcp_servers.komposit.args=${tomlList(server.args)}`),
    ...(Object.keys(server.env || {}).length ? c(`mcp_servers.komposit.env=${tomlTable(server.env)}`) : []),
    ...c(`mcp_servers.komposit.required=true`), // no tools, no run
    ...c(`mcp_servers.komposit.startup_timeout_sec=${STARTUP_TIMEOUT_SEC}`),
    ...c(`mcp_servers.komposit.tool_timeout_sec=${TOOL_TIMEOUT_SEC}`),
    // Komposit's tools carry no MCP annotations; without this, Codex treats
    // them as needing approval and, with approval "never", declines every call.
    ...c(`mcp_servers.komposit.default_tools_approval_mode="approve"`),
    // Listed up front with their parameters, not left for the model to search for.
    ...c(`mcp_servers.komposit.omit_tools_from=["deferred"]`),
    ...off.flatMap((f) => c(`features.${f}=false`)),
  ];
  if (effort) args.push(...c(`model_reasoning_effort=${toml(effort)}`));
  if (authStore) args.push(...c(`cli_auth_credentials_store=${toml(authStore)}`));
  if (resume) args.push("resume", resume);
  for (const p of imagePaths) args.push("--image", p);
  return args;
}

// A one-off run with no tools at all (chat titles): nothing kept on disk, low
// effort, `instructions` as the developer message. The prompt goes on stdin.
export function codexPlainArgs({ instructions, authStore = null } = {}) {
  const c = (kv) => ["-c", kv];
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    ...c(`approval_policy="never"`),
    ...c(`model_reasoning_effort="low"`),
    ...c(`tools.experimental_request_user_input.enabled=false`),
    ...c(`agents.enabled=false`),
    ...c(`web_search="disabled"`),
    ...c(`project_doc_max_bytes=0`),
    ...c(`skills.include_instructions=false`),
    ...c(`skills.bundled.enabled=false`),
    ...c(`developer_instructions=${toml(instructions)}`),
    ...OFF_FEATURES.concat("view_image").flatMap((f) => c(`features.${f}=false`)),
  ];
  if (authStore) args.push(...c(`cli_auth_credentials_store=${toml(authStore)}`));
  return args;
}

// The last agent message in a `codex exec --json` stream, or "".
export function lastMessage(jsonl) {
  let text = "";
  for (const l of String(jsonl || "").split("\n")) {
    try {
      const ev = JSON.parse(l);
      if (ev.type === "item.completed" && ev.item?.type === "agent_message") text = ev.item.text || "";
    } catch {}
  }
  return text;
}

// ---------- events ----------

export function newContext({ resume = null } = {}) {
  return { resume, threadId: null, lastMessage: "", completed: false, failed: false, warned: false, tools: {}, toolMs: 0, turnAt: 0, lastError: "" };
}

// "**Checking the layers**\n\nI need ..." -> ["Checking the layers"]. Codex's
// reasoning summaries start each part with a bold title; the titles read as
// progress lines. Without titles, the first paragraph.
export function reasoningNotes(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  const titles = [...t.matchAll(/^\*\*(.+?)\*\*\s*$/gm)].map((m) => m[1].trim()).filter(Boolean);
  if (titles.length) return titles;
  const first = t.split(/\n\s*\n/)[0].replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim();
  return [first.length > 200 ? first.slice(0, 197).replace(/\s+\S*$/, "") + "…" : first];
}

// An MCP tool result -> tool_done fields.
function mcpDone(item) {
  let text = "";
  let image = null;
  for (const b of item.result?.content || []) {
    if (b?.type === "image" && b.data) image = { media_type: b.mimeType || b.mime_type || "image/png", data: b.data };
    else if (b?.type === "text") text += b.text || "";
  }
  if (!text && item.error?.message) text = item.error.message;
  // To the end of the line: on Windows the temp folder can contain spaces.
  const vm = text.match(/Preview video: (.+?\.mp4)\s*$/m);
  return { display: text.slice(0, 200), image, video: vm ? vm[1] : null, is_error: item.status === "failed" || !!item.error };
}

const isAuthError = (m) => /\b401\b|unauthori[sz]ed|not logged in|missing bearer|please (re-?)?log ?in|sign in again|refresh token/i.test(String(m || ""));
// No credentials at all: retrying can't help (any other 401 may still be
// fixed by Codex refreshing its token, so that one runs its course).
const isNoLogin = (m) => /missing bearer|not logged in/i.test(String(m || ""));

// One `codex exec --json` event -> Komposit events. Returns "auth" when the
// run can't succeed (not signed in), so the caller can stop it early instead
// of sitting through Codex's reconnect attempts (about 20 s).
export function handleEvent(ev, emit, ctx) {
  const item = ev.item || {};
  switch (ev.type) {
    case "thread.started":
      ctx.threadId = ev.thread_id || ctx.threadId;
      // Resuming by name Codex may not find the thread and start a new one.
      if (ctx.resume && ctx.threadId && ctx.threadId !== ctx.resume) {
        emit({ type: "note", text: "Couldn't continue the earlier Codex session, so this message starts a fresh one." });
      }
      return;
    case "turn.started":
      ctx.turnAt = Date.now();
      return;
    case "item.started":
      if (item.type === "mcp_tool_call") {
        ctx.tools[item.id] = { name: item.tool, at: Date.now() };
        emit({ type: "tool_run", id: item.id, name: item.server === "komposit" ? item.tool : `${item.server}__${item.tool}`, input: item.arguments || {} });
      } else if (item.type === "command_execution" || item.type === "web_search") {
        // Off for Komposit runs; shown in plain words if a Codex build runs them anyway.
        const name = item.type === "web_search" ? "web_search" : "command";
        ctx.tools[item.id] = { name, at: Date.now() };
        emit({ type: "tool_run", id: item.id, name, input: {} });
      }
      return;
    case "item.completed":
      if (item.type === "reasoning") {
        for (const text of reasoningNotes(item.text)) emit({ type: "note", text });
      } else if (item.type === "agent_message") {
        // Shown as it arrives; the last one becomes the final message at
        // turn.completed (the server drops the duplicate note).
        if (String(item.text || "").trim()) emit({ type: "note", text: item.text });
        ctx.lastMessage = item.text || "";
      } else if (item.type === "mcp_tool_call") {
        const t = ctx.tools[item.id];
        if (t) ctx.toolMs += Date.now() - t.at;
        emit({ type: "tool_done", id: item.id, name: item.server === "komposit" ? item.tool : `${item.server}__${item.tool}`, ...mcpDone(item) });
      } else if (item.type === "command_execution" || item.type === "web_search") {
        const t = ctx.tools[item.id];
        if (!t) return; // never started
        ctx.toolMs += Date.now() - t.at;
        const failed = item.status === "failed" || item.status === "declined" || (item.exit_code != null && item.exit_code !== 0);
        emit({ type: "tool_done", id: item.id, name: t.name, display: String(item.aggregated_output || "").slice(0, 200), image: null, video: null, is_error: failed });
      } else if (item.type === "error") {
        // Non-fatal notices (ignored settings, transport fallbacks): kept for
        // the error message if the run fails, not shown.
        ctx.lastError = item.message || ctx.lastError;
      }
      // file_change, todo_list, collab_tool_call: nothing to show.
      return;
    case "error": {
      // Codex reports reconnect attempts as errors and keeps going; only
      // turn.failed ends the turn.
      ctx.lastError = ev.message || ctx.lastError;
      if (isNoLogin(ev.message)) return "auth";
      if (!ctx.warned && /reconnecting/i.test(ev.message || "")) {
        ctx.warned = true;
        emit({ type: "note", text: "Having trouble reaching ChatGPT, retrying." });
      }
      return;
    }
    case "turn.completed":
      ctx.completed = true;
      emit({ type: "final", text: ctx.lastMessage || "" });
      emit({ type: "timing", modelMs: ctx.turnAt ? Math.max(0, Date.now() - ctx.turnAt - ctx.toolMs) : null });
      return;
    case "turn.failed": {
      ctx.failed = true;
      const msg = String(ev.error?.message || ctx.lastError || "Codex couldn't finish this turn.");
      if (isAuthError(msg)) return "auth";
      emit({ type: "error", message: limitMessage(msg) || `Codex stopped: ${msg.slice(0, 400)}`, code: "codex_result" });
      return;
    }
    default:
      return;
  }
}

// The ChatGPT plan's usage limit, in plain words (Codex's own text names it).
function limitMessage(msg) {
  if (!/usage limit|rate limit|too many requests|\b429\b/i.test(msg)) return "";
  const when = /try again (in|at|after) ([^.]+)/i.exec(msg);
  return `Your ChatGPT plan has reached its Codex usage limit${when ? `; it resets ${when[1]} ${when[2].trim()}` : " for now"}. Try again later, or pick another AI in Settings.`;
}

const authMessage = (shell) =>
  `Codex isn't signed in to ChatGPT. Run \`codex login\` in ${shell} and sign in with your ChatGPT account, then try again.`;
const apiKeyMessage = (shell) =>
  `Codex is signed in with an API key, not a ChatGPT plan. Run \`codex login\` in ${shell} and choose Sign in with ChatGPT, then try again.`;

// Codex's stderr without its progress chatter and log lines.
function stderrTail(s) {
  const lines = String(s || "")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^Reading (prompt|additional input) from stdin/.test(l) && !/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+(TRACE|DEBUG|INFO|WARN)\b/.test(l));
  return lines.join("\n").trim().slice(-300);
}

// ---------- a turn ----------

// Run one message. Returns { sessionId } to resume next time, or
// { resumeFailed: true } when the saved thread could not be continued.
export async function runCodexTurn({ app = "illustrator", userText, emit = () => {}, signal, effort = "", images = [], fileDirs = [], resume = null }) {
  const shell = platform.name === "win" ? "PowerShell" : "Terminal";
  const codex = await findCodex();
  if (!codex) {
    emit({ type: "error", message: "Codex isn't installed. Open Settings to set it up, or pick another AI.", code: "codex_missing" });
    return {};
  }

  // Signed in with a ChatGPT plan? Codex itself would otherwise retry for
  // about 20 s before giving up, or bill an API key it was signed in with.
  // The cached answer is re-checked before it blocks a turn.
  let st = await codexStatus();
  if (st.installed && (st.broken || (st.statusKnown && !st.usesSubscription))) st = await codexStatus({ fresh: true });
  if (st.broken) {
    emit({ type: "error", message: brokenCodexMessage(codex), code: "codex_broken" });
    return {};
  }
  if (st.statusKnown && !st.loggedIn) {
    emit({ type: "error", message: authMessage(shell), code: "codex_auth" });
    return {};
  }
  if (st.statusKnown && !st.usesSubscription) {
    emit({ type: "error", message: apiKeyMessage(shell), code: "codex_auth" });
    return {};
  }

  mkdirSync(WORK_DIR, { recursive: true });

  // Reference images go in as files with --image. Codex splits that option's
  // value on commas, so a folder with a comma in its name falls back to temp.
  const refDir = join(WORK_DIR, "refs").includes(",") ? tmpdir() : join(WORK_DIR, "refs");
  mkdirSync(refDir, { recursive: true });
  const refPaths = [];
  images.forEach((img, i) => {
    try {
      const ext = img.media_type === "image/jpeg" ? "jpg" : img.media_type === "image/webp" ? "webp" : img.media_type === "image/gif" ? "gif" : "png";
      const p = join(refDir, `ref-${Date.now()}-${i}.${ext}`);
      if (p.includes(",")) return;
      writeFileSync(p, Buffer.from(img.data, "base64"));
      refPaths.push(p);
    } catch {}
  });
  const promptText = refPaths.length
    ? `${userText || "Use the attached reference."}\n\n[The user attached ${refPaths.length === 1 ? "a reference image" : "reference images"}: apply what's relevant.]`
    : userText;

  // The doc server's settings travel with it (Codex gives MCP servers only a
  // small fixed environment).
  const serverEnv = { KOMPOSIT_DATA_DIR: DATA_DIR };
  for (const k of SERVER_ENV) if (process.env[k]) serverEnv[k] = process.env[k];

  const args = codexArgs({
    app,
    effort,
    resume,
    imagePaths: refPaths,
    withFiles: fileDirs.length > 0,
    authStore: codexAuthStore(),
    server: { command: process.execPath, args: [MCP_SERVER, "--app", app], env: serverEnv },
  });

  // Subscription billing only: no API keys or endpoint overrides reach Codex.
  const childEnv = codexEnv(await userEnv());

  const ctx = newContext({ resume });
  let result = {};
  let authFail = false;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      settled = true;
      for (const p of refPaths) rmSync(p, { force: true });
      resolve();
    };
    // spawn() can throw instead of emitting "error" (ENOEXEC: a broken
    // install), so both paths are handled.
    const startFailed = (e) => {
      if (settled) return;
      if (isBrokenCodex(e)) emit({ type: "error", message: brokenCodexMessage(codex), code: "codex_broken" });
      else emit({ type: "error", message: `Could not start Codex: ${e.message}`, code: "codex_spawn" });
      finish();
    };
    // Own process group (Mac) and taskkill /T (Windows), so Stop ends Codex
    // and what it started. Codex starts the doc server in a group of its own;
    // the doc server quits as soon as Codex's end of its stdin closes.
    let child;
    try {
      child = spawn(codex, args, { cwd: WORK_DIR, stdio: ["pipe", "pipe", "pipe"], env: childEnv, ...platform.groupSpawnOptions });
    } catch (e) {
      return startFailed(e);
    }
    child.stdin.on("error", () => {});
    child.stdin.end(promptText || "");
    const kill = () => platform.killTree(child);
    if (signal) {
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }

    let buf = "";
    const line = (raw) => {
      const l = raw.trim();
      if (!l || authFail) return;
      let ev;
      try {
        ev = JSON.parse(l);
      } catch {
        return;
      }
      if (handleEvent(ev, emit, ctx) === "auth") {
        authFail = true;
        kill();
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        line(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });

    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", startFailed);
    child.on("close", (code) => {
      if (settled) return;
      if (signal) signal.removeEventListener("abort", kill);
      line(buf);
      const msg = stderrTail(stderr);
      if (signal?.aborted) {
        emit({ type: "aborted" });
        result = ctx.threadId ? { sessionId: ctx.threadId } : {};
      } else if (authFail) {
        emit({ type: "error", message: authMessage(shell), code: "codex_auth" });
      } else if (ctx.completed) {
        result = ctx.threadId ? { sessionId: ctx.threadId } : {};
      } else if (ctx.failed) {
        // turn.failed was already reported.
      } else if (isBrokenCodex(null, stderr)) {
        emit({ type: "error", message: brokenCodexMessage(codex), code: "codex_broken" });
      } else if (isAuthError(stderr)) {
        emit({ type: "error", message: authMessage(shell), code: "codex_auth" });
      } else if (resume && /no rollout|rollout .*not found|thread .*not found|session .*not found|no (thread|session|conversation) found|failed to resume/i.test(stderr)) {
        emit({ type: "error", message: "Couldn't continue the earlier Codex session; your next message starts a fresh one.", code: "codex_resume" });
        result = { resumeFailed: true };
      } else if (/required MCP servers failed to initialize/i.test(stderr)) {
        emit({ type: "error", message: `Komposit's tools didn't start inside Codex. ${msg}`.trim(), code: "codex_exit" });
      } else {
        emit({ type: "error", message: `Codex stopped${code ? ` (exit ${code})` : " before finishing"}. ${msg}`.trim(), code: "codex_exit" });
      }
      finish();
    });
  });
  return result;
}
