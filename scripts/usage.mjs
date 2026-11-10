#!/usr/bin/env node
// What your Komposit requests would cost on the model APIs.
//
// With the Claude subscription engine, Komposit runs Claude Code, and Claude
// Code logs every model call it makes (model and token counts) under
// ~/.claude/projects/<Komposit's work folder>/. This reads those logs and prices
// them at API list prices: what you actually ran, then the same tokens on a few
// other models. Nothing leaves your computer.
//
//   npm run usage              everything in the logs
//   npm run usage -- --days 7  the last 7 days
//
// Claude Code deletes logs older than `cleanupPeriodDays` (default 30) in
// ~/.claude/settings.json. Raise it to keep a longer history.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// USD per 1M tokens, list prices checked 2026-11-11 (platform.claude.com,
// aistudio.google.com/docs/pricing, developers.openai.com/api/docs/pricing).
// Anthropic: [input, cache write 5 min, cache write 1 h, cache read, output].
const ANTHROPIC = {
  "claude-fable-5-2": [8, 10, 16, 0.2, 40],
  "claude-opus-5-5": [4, 5, 8, 0.2, 20],
  "claude-opus-4-8": [5, 6.25, 10, 0.5, 25],
  "claude-sonnet-5-5": [2, 2.5, 4, 0.1, 10],
};
// The same tokens elsewhere: [input, cached input, output]. Rough: other
// tokenizers count differently, other models take a different number of steps,
// and their caching is automatic (cheap reads only when it hits).
const OTHERS = {
  "gemini-3.8-flash": [0.75, 0.075, 3.75],
  "gemini-3.8-flash from 2027-01-01": [1.5, 0.15, 7.5],
  "gemini-4-carbon": [2, 0.1, 10],
  "gpt-6.1-terra": [1, 0.05, 5],
  "gpt-6.1-sol": [2, 0.1, 10],
  "gpt-6-astra": [10, 1, 50],
};

const args = process.argv.slice(2);
const daysArg = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 0;
const since = daysArg > 0 ? Date.now() - daysArg * 86400000 : 0;

const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
const dirs = existsSync(projects)
  ? readdirSync(projects).filter((d) => /komposit-claude-code$/i.test(d)).map((d) => join(projects, d))
  : [];
if (!dirs.length) {
  console.log(`No Komposit runs found in ${projects}. They appear after a request with the Claude subscription engine.`);
  process.exit(0);
}

const day = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const usd = (n) => `$${n.toFixed(2)}`;

const seen = new Set();
const tokens = { input: 0, write5m: 0, write1h: 0, read: 0, output: 0 };
const models = new Map(); // model -> { calls, cost }
const days = new Map(); // day -> { requests, cost }
const requestCosts = [];
let calls = 0;

for (const dir of dirs) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    let current = null; // the cost of the request being read
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const at = Date.parse(e.timestamp);
      if (!(at >= since)) continue;
      const m = e.message || {};
      // A request is a typed prompt (tool results come back as arrays).
      if (e.type === "user" && typeof m.content === "string" && !e.isMeta) {
        if (current !== null) requestCosts.push(current);
        current = 0;
        const d = days.get(day(at)) || { requests: 0, cost: 0 };
        d.requests++;
        days.set(day(at), d);
        continue;
      }
      if (e.type !== "assistant" || !m.usage || !ANTHROPIC[m.model]) continue;
      // One response is logged once per content block: count it once.
      const id = m.id || e.requestId;
      if (seen.has(id)) continue;
      seen.add(id);
      const u = m.usage;
      const cc = u.cache_creation || {};
      let w5 = cc.ephemeral_5m_input_tokens || 0;
      const w1 = cc.ephemeral_1h_input_tokens || 0;
      if (!w5 && !w1) w5 = u.cache_creation_input_tokens || 0;
      const t = { input: u.input_tokens || 0, write5m: w5, write1h: w1, read: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 };
      const [pi, p5, p1, pr, po] = ANTHROPIC[m.model];
      const cost = (t.input * pi + t.write5m * p5 + t.write1h * p1 + t.read * pr + t.output * po) / 1e6;
      for (const k of Object.keys(tokens)) tokens[k] += t[k];
      const mm = models.get(m.model) || { calls: 0, cost: 0 };
      mm.calls++;
      mm.cost += cost;
      models.set(m.model, mm);
      const d = days.get(day(at)) || { requests: 0, cost: 0 };
      d.cost += cost;
      days.set(day(at), d);
      if (current !== null) current += cost;
      calls++;
    }
    if (current !== null) requestCosts.push(current);
  }
}

if (!calls) {
  console.log("No model calls in that period.");
  process.exit(0);
}
const total = [...models.values()].reduce((s, m) => s + m.cost, 0);
const sorted = requestCosts.slice().sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)] || 0;
const dayKeys = [...days.keys()].sort();

console.log(`Komposit through Claude Code: ${requestCosts.length} requests, ${calls} model calls, ${dayKeys[0]} to ${dayKeys.at(-1)}`);
console.log(`At API list prices: ${usd(total)} (per request: median ${usd(median)}, average ${usd(total / Math.max(1, requestCosts.length))})\n`);
for (const [model, m] of [...models].sort((a, b) => b[1].cost - a[1].cost)) {
  console.log(`  ${model.padEnd(20)} ${String(m.calls).padStart(6)} calls  ${usd(m.cost).padStart(9)}`);
}
console.log("\nBy day:");
for (const k of dayKeys) {
  const d = days.get(k);
  console.log(`  ${k}  ${String(d.requests).padStart(4)} requests  ${usd(d.cost).padStart(9)}`);
}
const fresh = tokens.input + tokens.write5m + tokens.write1h;
console.log(`\nTokens: ${(fresh / 1e6).toFixed(2)}M new input, ${(tokens.read / 1e6).toFixed(2)}M cached input, ${(tokens.output / 1e6).toFixed(2)}M output`);
console.log("\nThe same tokens on other models (rough):");
const [si, s5, s1, sr, so] = ANTHROPIC["claude-sonnet-5-5"];
const sonnet = (tokens.input * si + tokens.write5m * s5 + tokens.write1h * s1 + tokens.read * sr + tokens.output * so) / 1e6;
console.log(`  ${"all on claude-sonnet-5-5".padEnd(34)} ${usd(sonnet).padStart(9)}`);
for (const [name, [pi, pc, po]] of Object.entries(OTHERS)) {
  console.log(`  ${name.padEnd(34)} ${usd((fresh * pi + tokens.read * pc + tokens.output * po) / 1e6).padStart(9)}`);
}
