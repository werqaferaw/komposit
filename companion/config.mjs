// Local settings for one install. Lives only on the tester's computer:
//   Mac:      ~/Library/Application Support/Komposit/config.json   (mode 0600)
//   Windows:  %APPDATA%\Komposit\config.json
//
// It holds the per-install access token (every browser call must present it),
// the AI the tester chose (Claude Code, an Anthropic key, an OpenAI-compatible
// key, or an invite code for the owner's gateway) and onboarding state.
// Secrets in here go to exactly one place: the AI provider the tester picked.
// The UI only ever sees hints such as "sk-ant-…3f9a".
//
// For development, the repo's .env still works as a fallback: when no AI is
// chosen in settings, MODEL_PROVIDER=cli means Claude Code and an
// ANTHROPIC_API_KEY means the Anthropic API.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import "./env.mjs"; // loads .env into process.env (dev only; the DMG has none)
import platform from "./platform/index.mjs";

export const DATA_DIR = process.env.KOMPOSIT_DATA_DIR || platform.defaultDataDir();
export const CONFIG_FILE = join(DATA_DIR, "config.json");

export const AI_MODES = ["claude-code", "anthropic", "openai", "invite", "codex"];

// Where invite codes are checked and the owner's key is applied. Overridable
// for staging; the key itself never leaves that gateway.
export const DEFAULT_GATEWAY = process.env.KOMPOSIT_GATEWAY || "https://gateway.komposit.werq.dev";

let cfg = null;

function blank() {
  return {
    version: 1,
    token: randomBytes(24).toString("base64url"),
    ai: { mode: null, anthropic: {}, openai: {}, invite: {}, claudeCode: {} },
    onboarded: false,
    createdAt: new Date().toISOString(),
  };
}

// The live settings object (loaded once, created on first run).
export function config() {
  if (cfg) return cfg;
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  let disk = null;
  try {
    disk = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {}
  const base = blank();
  cfg = disk ? { ...base, ...disk, ai: { ...base.ai, ...(disk.ai || {}) } } : base;
  if (!disk || !disk.token) persist();
  return cfg;
}

function persist() {
  const tmp = CONFIG_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, CONFIG_FILE);
}

// Change settings and write them atomically.
export function updateConfig(mutate) {
  const c = config();
  mutate(c);
  persist();
  return c;
}

export function token() {
  return config().token;
}

// The AI to use for a turn: what the tester chose in settings, else the dev
// .env, else nothing (the UI then runs onboarding).
export function effectiveAI() {
  const c = config();
  if (c.ai.mode && AI_MODES.includes(c.ai.mode)) return { ...c.ai, source: "settings" };
  const p = process.env.MODEL_PROVIDER;
  if (p === "cli") return { mode: "claude-code", claudeCode: {}, source: "env" };
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      mode: "anthropic",
      anthropic: {
        apiKey: process.env.ANTHROPIC_API_KEY,
        baseUrl: process.env.MODEL_BASE_URL || undefined,
        model: process.env.MODEL || undefined,
      },
      source: "env",
    };
  }
  return { mode: null, source: "none" };
}

export function keyHint(k) {
  if (!k) return null;
  const s = String(k);
  return s.length <= 12 ? "…" + s.slice(-4) : s.slice(0, 7) + "…" + s.slice(-4);
}

// What the UI may see: modes, models and hints, never a secret.
export function publicAI() {
  const ai = effectiveAI();
  return {
    mode: ai.mode,
    source: ai.source,
    anthropic: {
      hasKey: !!ai.anthropic?.apiKey,
      keyHint: keyHint(ai.anthropic?.apiKey),
      model: ai.anthropic?.model || null,
    },
    openai: {
      hasKey: !!ai.openai?.apiKey,
      keyHint: keyHint(ai.openai?.apiKey),
      baseUrl: ai.openai?.baseUrl || null,
      model: ai.openai?.model || null,
    },
    invite: {
      hasCode: !!ai.invite?.code,
      codeHint: keyHint(ai.invite?.code),
      name: ai.invite?.name || null,
    },
  };
}
