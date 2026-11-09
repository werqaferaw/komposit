// First-run setup: everything a new tester needs before the first edit, as
// checks the UI can show and actions it can trigger.
//
//   apps        which Adobe apps are installed / running, and whether Komposit
//               may control them (macOS: the Automation permission; Windows has
//               no such permission, so it's a test of the connection)
//   files       access to Desktop, Documents and Downloads (where designs live)
//   claude      Claude Code installed and signed in (for the subscription path)
//   ai          which AI is configured (never the secret itself)
//
// System calls (Spotlight, `open`, the permission helper, the registry) go
// through the platform layer.
import { readdir } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { appManifest, getBridge } from "./bridges/index.mjs";
import { runningApps } from "./desktop.mjs";
import { config, updateConfig, publicAI, DEFAULT_GATEWAY, AI_MODES } from "./config.mjs";
import { claudeStatus, codexStatus } from "./shellenv.mjs";
import platform from "./platform/index.mjs";

// ---------- Adobe apps + Automation permission ----------

const automationState = (app, opts) => platform.automationState(app, opts);
const helperPath = () => platform.helperPath();

let _installed = null;
let _installedAt = 0;
async function installedApps() {
  if (_installed && Date.now() - _installedAt < 60000) return _installed;
  _installed = await platform.installedApps();
  _installedAt = Date.now();
  return _installed;
}

export async function appsStatus() {
  const [installed, running] = await Promise.all([installedApps(), runningApps()]);
  const manifest = appManifest();
  return Promise.all(
    manifest.map(async (a) => {
      const isRunning = !!running[a.id];
      const automation = isRunning ? await automationState(a.id) : "not-running";
      const issue = isRunning && a.id === "aftereffects" && automation !== "denied" ? await aeIssue() : null;
      return { id: a.id, label: a.label, installed: !!installed[a.id] || isRunning, running: isRunning, automation, ...(issue ? { issue } : {}) };
    }),
  );
}

// After Effects only hands results back once its "Allow Scripts to Write Files
// and Access Network" setting is on (off by default). A quick read-only probe,
// cached briefly; skipped when macOS hasn't allowed control yet.
let _aeIssue = { at: 0, value: null };
async function aeIssue({ fresh = false } = {}) {
  if (!fresh && Date.now() - _aeIssue.at < 30000) return _aeIssue.value;
  let value = null;
  try {
    await getBridge("aftereffects").listDocuments();
  } catch (e) {
    if (e.code === "AE_SCRIPT_FILES") value = "ae-script-files";
    if (e.code === "AE_DIALOG") value = "ae-dialog";
  }
  _aeIssue = { at: Date.now(), value };
  return value;
}

// Ask macOS for permission to control one app. The app must be running; the
// dialog is attributed to Komposit. Without the helper (repo checkout) we
// send a harmless read-only script instead, which triggers the same dialog.
// On Windows there is no permission to ask for: the same read-only script
// tests the connection.
export async function requestAutomation(app) {
  const running = await runningApps();
  if (!running[app]) return { automation: "not-running" };
  if (platform.name === "mac" && (await helperPath())) {
    const automation = await automationState(app, { ask: true });
    const issue = app === "aftereffects" && automation === "allowed" ? await aeIssue({ fresh: true }) : null;
    return { automation, ...(issue ? { issue } : {}) };
  }
  try {
    await getBridge(app).listDocuments();
    await platform.noteConnected(app);
    return { automation: "allowed" };
  } catch (e) {
    if (e.code === "AE_SCRIPT_FILES") return { automation: "allowed", issue: "ae-script-files" };
    if (e.code === "AE_DIALOG") return { automation: "allowed", issue: "ae-dialog" };
    return { automation: e.code === "AUTOMATION_DENIED" ? "denied" : "unknown", error: e.message };
  }
}

// Open an Adobe app (launches it; Komposit can then ask for permission).
export async function launchApp(app) {
  return platform.launchApp(app);
}

// ---------- Files ----------

const FOLDERS = ["desktop", "documents", "downloads"];

// On a Mac, reading a protected folder for the first time shows a prompt, so
// we only read once the person chose to grant access (filesAsked). Windows
// doesn't ask, so there it counts as asked from the start.
export async function filesStatus() {
  const asked = !platform.folderPrompts || !!config().filesAsked;
  const dirs = await platform.designFolders();
  const out = { asked };
  for (const k of FOLDERS) {
    if (!asked) {
      out[k] = "not-asked";
      continue;
    }
    try {
      await readdir(dirs[k]);
      out[k] = "allowed";
    } catch (e) {
      out[k] = e.code === "EPERM" || e.code === "EACCES" ? "denied" : "allowed";
    }
  }
  return out;
}

export async function requestFiles() {
  const dirs = await platform.designFolders();
  for (const k of FOLDERS) {
    try {
      await readdir(dirs[k]); // shows the prompt, one folder at a time
    } catch {}
  }
  updateConfig((c) => {
    c.filesAsked = true;
  });
  return filesStatus();
}

// ---------- System Settings ----------

export async function openSettingsPane(kind) {
  return platform.openSettingsPane(kind);
}

// ---------- AI choice ----------

const OPENAI_PRESETS = {
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-5.5" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-5" },
};

function flavorOf(baseUrl) {
  try {
    const h = new URL(baseUrl).hostname;
    if (h.endsWith("openrouter.ai")) return "openrouter";
    if (h === "api.openai.com") return "openai";
  } catch {}
  return "generic";
}

async function checkAnthropicKey(apiKey) {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 15000 });
  try {
    await client.models.list({ limit: 1 });
    return { ok: true };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, error: "That key was not accepted by Anthropic." };
    if (e instanceof Anthropic.PermissionDeniedError) return { ok: false, error: "That key has no access to the API." };
    return { ok: false, error: `Could not reach Anthropic: ${e.message}` };
  }
}

async function checkOpenAIKey({ apiKey, baseUrl }) {
  const flavor = flavorOf(baseUrl);
  // OpenRouter lists models without auth, so check the key endpoint instead.
  const url = flavor === "openrouter" ? "https://openrouter.ai/api/v1/key" : `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000) });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "That key was not accepted." };
    if (!res.ok && res.status !== 404) return { ok: false, error: `The service answered ${res.status}.` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not reach ${baseUrl}: ${e.message}` };
  }
}

// Ask the invite gateway who this code belongs to (and its limits).
export async function checkInvite(code, gateway = DEFAULT_GATEWAY) {
  try {
    const res = await fetch(`${gateway.replace(/\/+$/, "")}/v1/me`, {
      headers: { "x-api-key": code },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) return { ok: false, error: "That invite code isn't valid." };
    if (!res.ok) return { ok: false, error: `The invite service answered ${res.status}.` };
    const me = await res.json();
    return { ok: true, name: me.name || null, limits: me.limits || null, usage: me.usage || null };
  } catch (e) {
    return { ok: false, error: `Could not reach the invite service: ${e.message}` };
  }
}

// Save the AI choice after checking it works. Body:
//   { mode: "claude-code" }
//   { mode: "anthropic", apiKey, model? }
//   { mode: "openai", apiKey, baseUrl?|preset?, model? }
//   { mode: "invite", code }
export async function saveAI(body = {}) {
  const mode = String(body.mode || "");
  if (!AI_MODES.includes(mode)) return { ok: false, error: "Pick how Komposit should think." };
  const c = config();

  if (mode === "claude-code") {
    const st = await claudeStatus({ fresh: true });
    if (!st.installed) return { ok: false, error: "Claude Code isn't installed yet.", claude: st };
    if (st.broken) return { ok: false, error: "Claude Code's install looks broken. Reinstall it, then check again.", claude: st };
    if (!st.loggedIn) return { ok: false, error: "Claude Code is installed but not signed in.", claude: st };
    updateConfig((x) => {
      x.ai.mode = "claude-code";
    });
    return { ok: true, ai: publicAI() };
  }

  if (mode === "codex") {
    const st = await codexStatus({ fresh: true });
    if (!st.installed) return { ok: false, error: "Codex isn't installed yet.", codex: st };
    if (st.broken) return { ok: false, error: "Codex's install looks broken. Reinstall it, then check again.", codex: st };
    if (!st.loggedIn) return { ok: false, error: "Codex is installed but not signed in.", codex: st };
    if (!st.usesSubscription) return { ok: false, error: "Codex is signed in with an API key. Sign in with ChatGPT instead.", codex: st };
    updateConfig((x) => {
      x.ai.mode = "codex";
    });
    return { ok: true, ai: publicAI() };
  }

  if (mode === "anthropic") {
    const apiKey = String(body.apiKey || c.ai.anthropic?.apiKey || "").trim();
    if (!apiKey) return { ok: false, error: "Paste your Anthropic API key." };
    const chk = await checkAnthropicKey(apiKey);
    if (!chk.ok) return chk;
    updateConfig((x) => {
      x.ai.mode = "anthropic";
      x.ai.anthropic = { apiKey, model: body.model || x.ai.anthropic?.model || undefined };
    });
    return { ok: true, ai: publicAI() };
  }

  if (mode === "openai") {
    const preset = OPENAI_PRESETS[body.preset] || null;
    const baseUrl = String(body.baseUrl || preset?.baseUrl || c.ai.openai?.baseUrl || "").trim().replace(/\/+$/, "");
    const apiKey = String(body.apiKey || c.ai.openai?.apiKey || "").trim();
    const model = String(body.model || preset?.model || c.ai.openai?.model || "").trim();
    if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(baseUrl + "/")) {
      return { ok: false, error: "The service address must start with https://" };
    }
    if (!apiKey) return { ok: false, error: "Paste your API key." };
    if (!model) return { ok: false, error: "Name the model to use." };
    const chk = await checkOpenAIKey({ apiKey, baseUrl });
    if (!chk.ok) return chk;
    updateConfig((x) => {
      x.ai.mode = "openai";
      x.ai.openai = { apiKey, baseUrl, model, flavor: flavorOf(baseUrl) };
    });
    return { ok: true, ai: publicAI() };
  }

  if (mode === "invite") {
    const code = String(body.code || c.ai.invite?.code || "").trim();
    if (!code) return { ok: false, error: "Paste your invite code." };
    const chk = await checkInvite(code);
    if (!chk.ok) return chk;
    updateConfig((x) => {
      x.ai.mode = "invite";
      x.ai.invite = { code, name: chk.name };
    });
    return { ok: true, ai: publicAI(), limits: chk.limits };
  }
  return { ok: false, error: "Unknown choice." };
}

export function forgetAI() {
  updateConfig((x) => {
    x.ai = { mode: null, anthropic: {}, openai: {}, invite: {}, claudeCode: {} };
  });
  return { ok: true, ai: publicAI() };
}

export function markOnboarded(done = true) {
  updateConfig((x) => {
    x.onboarded = !!done;
  });
  return { ok: true };
}

// Everything the setup screens need, in one call.
export async function setupStatus({ fresh = false } = {}) {
  const codex = codexStatus({ fresh }); // alongside the checks below
  const [apps, files, claude] = await Promise.all([appsStatus(), filesStatus(), claudeStatus({ fresh })]);
  return {
    apps,
    files,
    claude,
    codex: await codex,
    ai: publicAI(),
    onboarded: !!config().onboarded,
    helper: !!(await helperPath()),
    presets: OPENAI_PRESETS,
  };
}
