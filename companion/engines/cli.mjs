// The Claude Code engine. Instead of calling the API with a key, this runs the
// tester's own `claude` (billed to their Claude subscription) and lets it
// drive the live document through Komposit's MCP tools. Its stream-json output
// is turned into the same events the API engine emits, so the UI looks the
// same whichever engine runs.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { esGuidance } from "../harness/guidance.mjs";
import { BEHAVIOR } from "../harness/behavior.mjs";
import { findClaude, userEnv, isBrokenClaude, brokenClaudeMessage } from "../shellenv.mjs";
import { DATA_DIR } from "../config.mjs";
import platform from "../platform/index.mjs";

// Windows limits a command line to 32,767 characters, and the message (with
// the selection and attached text) plus the system prompt can pass that. There
// the message goes in on stdin and the system prompt in a file.
const VIA_STDIN = platform.name === "win";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = join(HERE, "..", "mcp", "doc-server.mjs");
const TOOL_NAMES = ["inspect", "edit", "render", "export", "save", "preflight", "undo"];
const ALLOWED = TOOL_NAMES.map((t) => `mcp__komposit__${t}`);

// Claude Code keeps its sessions per working directory; one fixed folder
// keeps Komposit's sessions together (and resumable after a restart).
const WORK_DIR = join(DATA_DIR, "claude-code");

function steerFor(app) {
  return (
    `You are Komposit, working in the user's live Adobe ${app} document through the komposit MCP tools ` +
    `(inspect, edit, render, export, save, preflight, undo). Use ONLY those tools; do not use Bash, Write, or any other tool. ` +
    `Edits are ExtendScript (ES3): var, string concatenation, no modern JS. ` +
    `You keep context across messages in this conversation: reuse what you already inspected and the edits you already made; ` +
    `only inspect again when the document changed or you genuinely need fresh state.\n\n` +
    BEHAVIOR +
    `\n\nWrite CORRECT ExtendScript the FIRST time; use these exact patterns, don't guess the API:\n` +
    esGuidance(app)
  );
}

// The appended system prompt as a file (Windows; see VIA_STDIN).
function steerFile(app) {
  const p = join(WORK_DIR, `steer-${app}.txt`);
  writeFileSync(p, steerFor(app), "utf8");
  return p;
}

// Run one message. Returns { sessionId } to resume next time, or
// { resumeFailed: true } when the saved session could not be continued.
export async function runCliTurn({ app = "illustrator", userText, emit = () => {}, signal, model = "sonnet", effort = "", images = [], fileDirs = [], resume = null }) {
  const claude = await findClaude();
  if (!claude) {
    emit({ type: "error", message: "Claude Code isn't installed. Open Settings to set it up, or pick another AI.", code: "claude_missing" });
    return {};
  }

  mkdirSync(join(WORK_DIR, "refs"), { recursive: true });

  // Reference images: write them to files the model can open with Read.
  const refPaths = [];
  images.forEach((img, i) => {
    try {
      const ext = img.media_type === "image/jpeg" ? "jpg" : img.media_type === "image/webp" ? "webp" : "png";
      const p = join(WORK_DIR, "refs", `ref-${Date.now()}-${i}.${ext}`);
      writeFileSync(p, Buffer.from(img.data, "base64"));
      refPaths.push(p);
    } catch {}
  });
  // Read lets Claude Code look at reference images and attached files (PDFs,
  // text, images); the attachment folders are added so it may read there.
  const allowed = refPaths.length || fileDirs.length ? ALLOWED.concat("Read") : ALLOWED;
  const promptText = refPaths.length
    ? `${userText || "Use the attached reference."}\n\n[The user attached reference image(s). Look at them first with the Read tool, then apply what's relevant: ${refPaths.join(", ")}]`
    : userText;

  // MCP config: only Komposit's doc server for this app, run on the same Node
  // binary as this server (the app bundle ships its own).
  const cfgPath = join(WORK_DIR, `mcp-${app}.json`);
  writeFileSync(
    cfgPath,
    JSON.stringify({ mcpServers: { komposit: { command: process.execPath, args: [MCP_SERVER, "--app", app] } } }),
  );

  const args = [
    "-p", ...(VIA_STDIN ? [] : [promptText]),
    "--output-format", "stream-json", "--verbose",
    "--model", model,
    "--mcp-config", cfgPath,
    "--strict-mcp-config", // ignore the user's other MCP servers
    "--disable-slash-commands", // don't load the user's skills into context
    "--exclude-dynamic-system-prompt-sections", // better prompt-cache reuse across turns
    "--allowedTools", allowed.join(","),
    ...(VIA_STDIN ? ["--append-system-prompt-file", steerFile(app)] : ["--append-system-prompt", steerFor(app)]),
    "--permission-mode", "default",
  ];
  if (effort) args.push("--effort", effort);
  if (resume) args.push("--resume", resume);
  for (const d of fileDirs) args.push("--add-dir", d);

  // Subscription billing only: strip API-key variables so `claude` uses the
  // signed-in Claude account, never a metered key that happens to be set.
  const childEnv = await userEnv();
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.ANTHROPIC_AUTH_TOKEN;
  delete childEnv.ANTHROPIC_BASE_URL;

  const toolNames = {};
  const ctx = { sessionId: null, gotResult: false };
  let result = {};

  await new Promise((resolve) => {
    // Own process group (Mac), so Stop can kill claude AND the doc server it
    // spawned (a plain kill orphans the doc server, which keeps driving the
    // document). On Windows, killTree ends the tree with taskkill /T.
    // spawn() can throw instead of emitting "error" (ENOEXEC: a placeholder
    // left by an unfinished Claude Code update), so both paths are handled.
    const startFailed = (e) => {
      if (isBrokenClaude(e)) emit({ type: "error", message: brokenClaudeMessage(claude), code: "claude_broken" });
      else emit({ type: "error", message: `Could not start Claude Code: ${e.message}`, code: "claude_spawn" });
      for (const p of refPaths) rmSync(p, { force: true });
      resolve();
    };
    let child;
    try {
      child = spawn(claude, args, { cwd: WORK_DIR, stdio: [VIA_STDIN ? "pipe" : "ignore", "pipe", "pipe"], env: childEnv, ...platform.groupSpawnOptions });
    } catch (e) {
      return startFailed(e);
    }
    if (VIA_STDIN) {
      child.stdin.on("error", () => {});
      child.stdin.end(promptText);
    }
    const kill = () => platform.killTree(child);
    if (signal) {
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }

    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        handle(ev, emit, toolNames, ctx);
      }
    });

    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", startFailed);
    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", kill);
      if (signal?.aborted) {
        emit({ type: "aborted" });
        result = ctx.sessionId ? { sessionId: ctx.sessionId } : {};
      } else if (code !== 0 && code !== null && !ctx.gotResult) {
        const msg = stderr.trim();
        if (isBrokenClaude(null, msg)) {
          emit({ type: "error", message: brokenClaudeMessage(claude), code: "claude_broken" });
        } else if (/not logged in|please run \/login|authentication|invalid api key|oauth/i.test(msg)) {
          emit({ type: "error", message: "Claude Code is not signed in. Run `claude` in Terminal once to sign in, then try again.", code: "claude_auth" });
        } else if (resume && /session|resume|conversation/i.test(msg)) {
          emit({ type: "error", message: "Couldn't continue the earlier Claude Code session; your next message starts a fresh one.", code: "claude_resume" });
          result = { resumeFailed: true };
        } else {
          emit({ type: "error", message: `Claude Code stopped (exit ${code}). ${msg.slice(0, 300)}`, code: "claude_exit" });
        }
      } else if (ctx.sessionId) {
        result = { sessionId: ctx.sessionId };
      }
      for (const p of refPaths) rmSync(p, { force: true });
      resolve();
    });
  });
  return result;
}

function handle(ev, emit, toolNames, ctx) {
  if (ev.type === "system" && ev.subtype === "init" && ev.session_id) {
    ctx.sessionId = ev.session_id;
  } else if (ev.type === "system" && ev.subtype === "thinking_tokens") {
    // Claude Code hides the thinking itself but reports how much there is:
    // shown live, so a long silent plan doesn't look like a hang.
    if (Number.isFinite(ev.estimated_tokens)) emit({ type: "thinking", tokens: ev.estimated_tokens });
  } else if (ev.type === "assistant") {
    for (const b of ev.message?.content || []) {
      if (b.type === "text" && b.text?.trim()) emit({ type: "note", text: b.text });
      else if (b.type === "tool_use") {
        const name = (b.name || "").replace("mcp__komposit__", "");
        toolNames[b.id] = name;
        if (name === "ToolSearch") continue; // internal: Claude Code loading the tool list
        emit({ type: "tool_run", id: b.id, name, input: b.input || {} });
      }
    }
  } else if (ev.type === "user") {
    for (const b of ev.message?.content || []) {
      if (b.type !== "tool_result") continue;
      if (toolNames[b.tool_use_id] === "ToolSearch") continue;
      let image = null;
      let text = "";
      const c = b.content;
      if (Array.isArray(c)) {
        for (const cb of c) {
          if (cb.type === "image") {
            image = { media_type: cb.source?.media_type || cb.mimeType || "image/png", data: cb.source?.data || cb.data };
          } else if (cb.type === "text") text += cb.text || "";
        }
      } else if (typeof c === "string") text = c;
      // To the end of the line: on Windows the temp folder can contain spaces.
      const vm = text.match(/Preview video: (.+?\.mp4)\s*$/m);
      emit({
        type: "tool_done",
        id: b.tool_use_id,
        name: toolNames[b.tool_use_id] || "",
        display: text.slice(0, 200),
        image,
        video: vm ? vm[1] : null,
        is_error: !!b.is_error,
      });
    }
  } else if (ev.type === "result") {
    ctx.gotResult = true;
    if (ev.session_id) ctx.sessionId = ev.session_id;
    if (ev.is_error || ev.subtype?.startsWith("error")) {
      const msg = String(ev.result || ev.subtype || "Claude Code reported an error.");
      emit({ type: "error", message: msg.slice(0, 400), code: "claude_result" });
    } else {
      emit({ type: "final", text: ev.result || "" });
    }
    emit({ type: "timing", modelMs: ev.duration_api_ms || null });
  } else if (ev.type === "rate_limit_event") {
    const u = ev.rate_limit_info?.utilization;
    if (u != null && u > 0.9) {
      emit({ type: "note", text: `Heads-up: your Claude plan is at ${Math.round(u * 100)}% of its current usage window.` });
    }
  }
}
