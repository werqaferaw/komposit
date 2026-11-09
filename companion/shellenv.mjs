// The user's real shell environment. An app opened from Finder starts with a
// bare PATH (/usr/bin:/bin:/usr/sbin:/sbin), so `claude` would not be found.
// We ask the user's login shell for its PATH once (on Windows: the PATH in the
// registry, which has programs installed since sign-in), and also look in the
// usual install locations, so Claude Code (and Codex) is found however it was
// installed.
import { execFile } from "node:child_process";
import { existsSync, accessSync, constants, realpathSync, readFileSync } from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { homedir } from "node:os";
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

// ---------- Codex (ChatGPT plan) ----------

// The Codex CLI from npm (`npm install -g @openai/codex`) is a small Node
// launcher plus a native binary in a per-platform package. On Windows npm puts
// only codex.cmd / codex.ps1 on the PATH, which Node can't spawn without a
// shell, so the native codex.exe inside the package is used instead.
const CODEX_TRIPLES = {
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
};

// The native binary of an npm-installed Codex under an npm prefix folder (the
// folder holding codex.cmd on Windows), or null.
export function codexInNpm(prefix, { os = process.platform, arch = process.arch } = {}) {
  const triple = CODEX_TRIPLES[`${os}-${arch}`];
  if (!prefix || !triple) return null;
  const exe = os === "win32" ? "codex.exe" : "codex";
  const pkg = join(prefix, "node_modules", "@openai", "codex");
  const plat = `codex-${os}-${arch}`;
  const vendors = [
    join(pkg, "node_modules", "@openai", plat, "vendor", triple), // nested (npm -g)
    join(prefix, "node_modules", "@openai", plat, "vendor", triple), // hoisted
    join(pkg, "vendor", triple), // older single-package releases
  ];
  for (const v of vendors) {
    for (const p of [join(v, "bin", exe), join(v, "codex", exe)]) if (existsSync(p)) return p;
  }
  return null;
}

// Find the `codex` binary, or null. CODEX_PATH overrides, like CLAUDE_PATH.
export async function findCodex() {
  if (process.env.CODEX_PATH && isExec(process.env.CODEX_PATH)) return process.env.CODEX_PATH;
  for (const dir of (await userPath()).split(delimiter)) {
    for (const name of platform.codexNames) {
      const p = join(dir, name);
      if (existsSync(p) && isExec(p)) return p;
    }
    if (platform.name === "win") {
      const native = codexInNpm(dir);
      if (native) return native;
    }
  }
  return null;
}

// A `codex` that exists but can't run: the same signs as a broken Claude Code,
// plus the npm launcher's own message when its native binary is missing.
const CODEX_BROKEN_RE = /Missing optional dependency @openai\/codex|Unable to locate Codex CLI binaries/i;
export function isBrokenCodex(err, output = "") {
  return isBrokenClaude(err, output) || CODEX_BROKEN_RE.test(`${err?.message || ""}\n${output}`);
}

export function codexReinstallCommand(path) {
  let real = path || "";
  try {
    real = realpathSync(real);
  } catch {}
  if (/Caskroom[\\/]codex/i.test(real)) return "brew reinstall --cask codex";
  return "npm install -g @openai/codex";
}

export function brokenCodexMessage(path) {
  const shell = platform.name === "win" ? "PowerShell" : "Terminal";
  return `Codex's install looks broken. Reinstall it in ${shell} with \`${codexReinstallCommand(path)}\`, then try again.`;
}

// Komposit's Codex runs bill the ChatGPT plan Codex is signed in with, never a
// key: these variables would make Codex use an API key, a different token or a
// different endpoint instead.
export const CODEX_STRIP_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL"];
export function codexEnv(env) {
  for (const k of Object.keys(env)) if (CODEX_STRIP_ENV.includes(k.toUpperCase())) delete env[k];
  return env;
}

// `codex login status` (it prints to stderr). Strings from codex-cli 0.167.0
// (codex-rs/cli/src/login.rs); "Logged in using an API key" is the older form.
export function parseCodexLogin(text = "") {
  const t = String(text);
  if (/Logged in using ChatGPT/i.test(t)) return { loggedIn: true, authMethod: "chatgpt" };
  if (/API key configured|Logged in using an API key/i.test(t)) return { loggedIn: true, authMethod: "api-key" };
  if (/Logged in using personal access token/i.test(t)) return { loggedIn: true, authMethod: "personal-access-token" };
  if (/Logged in using access token/i.test(t)) return { loggedIn: true, authMethod: "access-token" };
  if (/Logged in using workload identity/i.test(t)) return { loggedIn: true, authMethod: "workload-identity" };
  if (/Logged in using Amazon Bedrock/i.test(t)) return { loggedIn: true, authMethod: "bedrock" };
  if (/Not logged in/i.test(t)) return { loggedIn: false, authMethod: null };
  return null;
}

// Sign-ins that bill a ChatGPT plan (or workspace), not an API key.
const CHATGPT_AUTH = ["chatgpt", "access-token", "personal-access-token", "workload-identity"];

export function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

// Komposit runs Codex without the person's config.toml, but their sign-in may
// live in the system keyring instead of auth.json; this setting says where.
export function codexAuthStore(home = codexHome()) {
  let text = "";
  try {
    text = readFileSync(join(home, "config.toml"), "utf8");
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break; // only top-level keys
    const m = /^\s*cli_auth_credentials_store\s*=\s*["']?(file|keyring|auto)["']?\s*(#.*)?$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

// Is Codex installed, and signed in with a ChatGPT plan? Cached briefly, like
// claudeStatus; `fresh` forces a re-check (after the person signs in).
let _codex = null;
let _codexAt = 0;
export async function codexStatus({ fresh = false } = {}) {
  if (!fresh && _codex && Date.now() - _codexAt < 30000) return _codex;
  const path = await findCodex();
  if (!path) {
    _codex = { installed: false, loggedIn: false };
    _codexAt = Date.now();
    return _codex;
  }
  const env = codexEnv(await userEnv());
  const [ver, auth] = await Promise.all([
    run(path, ["--version"], { env, timeout: 15000 }),
    run(path, ["login", "status"], { env, timeout: 15000 }),
  ]);
  const version = (/(\d+\.\d+\.\d+)/.exec(ver.stdout + ver.stderr) || [])[1] || null;
  if (!version && isBrokenCodex(ver.err, ver.stderr + ver.stdout)) {
    _codex = { installed: true, broken: true, loggedIn: false, path, reinstall: codexReinstallCommand(path) };
    _codexAt = Date.now();
    return _codex;
  }
  const info = parseCodexLogin(`${auth.stdout}\n${auth.stderr}`);
  _codex = {
    installed: true,
    path,
    version,
    loggedIn: !!info?.loggedIn,
    authMethod: info?.authMethod || null,
    usesSubscription: !!info?.loggedIn && CHATGPT_AUTH.includes(info.authMethod),
    statusKnown: !!info,
  };
  _codexAt = Date.now();
  return _codex;
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
