// A `claude` left half-installed by an update that didn't finish: the engine
// and the settings check must say how to reinstall, not "spawn ENOEXEC".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { isBrokenClaude, reinstallCommand, brokenClaudeMessage } from "../shellenv.mjs";

const STUB = 'echo "Error: claude native binary not installed." >&2\nexit 1\n';

test("the npm placeholder is recognized from its output", () => {
  assert.ok(isBrokenClaude(null, "Error: claude native binary not installed.\n"));
  assert.ok(isBrokenClaude({ code: "ENOEXEC", message: "spawn ENOEXEC" }));
  assert.ok(!isBrokenClaude(null, "Error: not logged in"));
  assert.ok(!isBrokenClaude({ code: "ENOENT" }));
});

test("an npm install is reinstalled with npm, others with the installer", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "komposit-claude-"));
  try {
    const pkg = join(dir, "lib/node_modules/@anthropic-ai/claude-code/bin");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "claude.exe"), STUB);
    mkdirSync(join(dir, "bin"));
    symlinkSync(join(pkg, "claude.exe"), join(dir, "bin/claude"));
    assert.equal(reinstallCommand(join(dir, "bin/claude")), "npm install -g @anthropic-ai/claude-code");
    assert.match(reinstallCommand("/Users/x/.local/bin/claude"), /claude\.ai\/install/);
    assert.match(brokenClaudeMessage(join(dir, "bin/claude")), /npm install -g @anthropic-ai\/claude-code/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawning the placeholder fails with ENOEXEC, which counts as broken", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "komposit-claude-"));
  try {
    const p = join(dir, "claude");
    writeFileSync(p, STUB); // no #! line, like the real placeholder
    chmodSync(p, 0o755);
    // Node may throw from spawn() or emit "error"; both must count as broken.
    const err = await new Promise((resolve) => {
      let c;
      try {
        c = spawn(p, ["--version"], { stdio: "ignore" });
      } catch (e) {
        return resolve(e);
      }
      c.on("error", resolve);
      c.on("close", () => resolve(null));
    });
    assert.ok(err, "spawn should fail");
    assert.ok(isBrokenClaude(err), `got ${err?.code}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a turn and the settings check both explain the broken install", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "komposit-claude-"));
  const saved = { path: process.env.CLAUDE_PATH, data: process.env.KOMPOSIT_DATA_DIR };
  try {
    const p = join(dir, "claude");
    writeFileSync(p, STUB);
    chmodSync(p, 0o755);
    process.env.CLAUDE_PATH = p;
    process.env.KOMPOSIT_DATA_DIR = join(dir, "data");
    const { runCliTurn } = await import("../engines/cli.mjs");
    const { claudeStatus } = await import("../shellenv.mjs");

    const events = [];
    await runCliTurn({ userText: "hi", emit: (e) => events.push(e) });
    const err = events.find((e) => e.type === "error");
    assert.equal(err?.code, "claude_broken", JSON.stringify(events));
    assert.match(err.message, /Reinstall/);

    const st = await claudeStatus({ fresh: true });
    assert.equal(st.broken, true);
    assert.equal(st.installed, true);
    assert.ok(st.reinstall);
  } finally {
    if (saved.path === undefined) delete process.env.CLAUDE_PATH; else process.env.CLAUDE_PATH = saved.path;
    if (saved.data === undefined) delete process.env.KOMPOSIT_DATA_DIR; else process.env.KOMPOSIT_DATA_DIR = saved.data;
    rmSync(dir, { recursive: true, force: true });
  }
});
