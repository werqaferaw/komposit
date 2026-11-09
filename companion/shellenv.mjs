// The user's real shell environment. An app opened from Finder starts with a
// bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so `claude` would not be found.
// We ask the user's login shell for its PATH once (on Windows: the PATH in the
// registry, which has programs installed since sign-in), and also look in the
// usual install locations, so Claude Code is found however it was installed.
import { execFile } from "node:child_process";
import { existsSync, accessSync, constants, realpathSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import platform from "./platform/index.mjs";

function run(cmd, args, { timeout = 8000, env } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, env, encoding: "utf8", maxBuffer: 1 << 20, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: stdout || "", stderr: stderr || "", err });
      });
    } catch (err) {
      resolve({ code: 1, stdout: "", stderr: "", err }); // e.g. ENOEXEC thrown by spawn
    }
  });
}

let _loginPath = null;
async function loginShellPath() {
  if (_loginPath !== null) return _loginPath;
  _loginPath = await platform.loginPath(run);
  return _loginPath;
}

const EXTRA_DIRS = platform.extraBinDirs();

// PATH for child processes: login shell PATH, the usual install dirs, our own
// bundled node (so an npm-installed `claude` can still find a node), then the
// process's own PATH.
let _path = null;
export async function userPath() {
  if (_path) return _path;
  const parts = [
    ...(await loginShellPath()).split(delimiter),
    ...EXTRA_DIRS,
    dirname(process.execPath),
    ...(process.env.PATH || "").split(delimiter),
    ...platform.systemPathDirs,
  ].filter(Boolean);
  _path = [...new Set(parts)].join(delimiter);
  return _path;
}

export async function userEnv(extra = {}) {
  // Windows spells it Path; set whichever name the environment already uses.
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  const env = { ...process.env, ...extra };
  env[key] = await userPath();
  return env;
}

function isExec(p) {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Find the `claude` binary, or null.
export async function findClaude() {
  if (process.env.CLAUDE_PATH && isExec(process.env.CLAUDE_PATH)) return process.env.CLAUDE_PATH;
  for (const dir of (await userPath()).split(delimiter)) {
    for (const name of platform.claudeNames) {
      const p = join(dir, name);
      if (existsSync(p) && isExec(p)) return p;
    }
  }
  return null;
}

// A `claude` that exists but can't run: an update that didn't finish leaves a
// placeholder script behind (ENOEXEC), or a binary for the wrong CPU.
const BROKEN_RE = /native binary not installed|ENOEXEC|exec format error|bad CPU type/i;
export function isBrokenClaude(err, output = "") {
  return ["ENOEXEC", "EACCES"].includes(err?.code) || BROKEN_RE.test(`${err?.message || ""}\n${output}`);
}

// How to reinstall: npm installs are fixed with npm, everything else with the
// official installer.
export function reinstallCommand(path) {
  let real = path || "";
  try {
    real = realpathSync(real);
  } catch {}
  if (/node_modules[\\/]@anthropic-ai[\\/]claude-code/.test(real)) return "npm install -g @anthropic-ai/claude-code";
  return platform.name === "win" ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash";
}

export function brokenClaudeMessage(path) {
  const shell = platform.name === "win" ? "PowerShell" : "Terminal";
  return `Claude Code's install looks broken, usually from an update that didn't finish. Reinstall it in ${shell} with \`${reinstallCommand(path)}\`, then try again.`;
}

// Is Claude Code installed, and signed in to a Claude account?
// Cached briefly; `fresh` forces a re-check (after the user signs in).
let _status = null;
let _statusAt = 0;
export async function claudeStatus({ fresh = false } = {}) {
  if (!fresh && _status && Date.now() - _statusAt < 30000) return _status;
  const path = await findClaude();
  if (!path) {
    _status = { installed: false, loggedIn: false };
    _statusAt = Date.now();
    return _status;
  }
  const env = await userEnv();
  const [ver, auth] = await Promise.all([
    run(path, ["--version"], { env, timeout: 15000 }),
    run(path, ["auth", "status", "--json"], { env, timeout: 15000 }),
  ]);
  const version = (/(\d+\.\d+\.\d+)/.exec(ver.stdout) || [])[1] || null;
  if (!version && isBrokenClaude(ver.err, ver.stderr + ver.stdout)) {
    _status = { installed: true, broken: true, loggedIn: false, path, reinstall: reinstallCommand(path) };
    _statusAt = Date.now();
    return _status;
  }
  let info = null;
  try {
    info = JSON.parse(auth.stdout);
  } catch {}
  _status = {
    installed: true,
    path,
    version,
    loggedIn: !!info?.loggedIn,
    authMethod: info?.authMethod || null,
    subscriptionType: info?.subscriptionType || null,
    // An API key in the environment would bill the key, not the subscription;
    // the engine strips it, so only a claude.ai sign-in counts here.
    usesSubscription: !!info?.loggedIn && (info?.authMethod === "claude.ai" || !!info?.subscriptionType),
    statusKnown: !!info,
  };
  _statusAt = Date.now();
  return _status;
}
