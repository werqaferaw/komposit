#!/usr/bin/env node
// Grant, change or revoke the monthly output-token allowance of a signed-in
// account, by email, and list accounts (the gateway's optional Google sign-in).
//
//   node gateway/scripts/grant.mjs <email> <tokens>    grant or change: 2000000, 2m, 500k
//   node gateway/scripts/grant.mjs revoke <email>      set the allowance to 0 (the account stays)
//   node gateway/scripts/grant.mjs list                every account
//
// Like mint-invite.mjs, it changes nothing by itself. It prints the exact
// `wrangler d1 execute` commands for the production D1 (--remote) and for the
// local D1 that `npm run dev` uses (--local). Add --run remote (or --run local)
// to run the command from here instead.
//
// Granting to someone who hasn't signed in yet creates a placeholder row. Their
// first sign-in claims it, but only if Google says that email is verified.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The D1 binding in wrangler.toml. */
export const DATABASE = "DB";

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"; // the same format as JavaScript's toISOString()
const SHOW_COLUMNS =
  "id, email, name, allowance, CASE WHEN google_sub IS NULL THEN 'not yet' ELSE 'yes' END AS signed_in, created_at";
// RFC 5322 "atext" for the part before the @, a hostname after it. Lowercase only: emails are stored lowercased.
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Lowercase and check an email address, the way the gateway stores it. Throws on anything else. */
export function normalizeEmail(raw) {
  const email = String(raw ?? "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) throw new Error(`"${raw}" doesn't look like an email address.`);
  return email;
}

/** A token count: 2000000, 2_000_000, 2,000,000, 2m or 500k. Throws on anything else. */
export function parseAllowance(raw) {
  const text = String(raw ?? "").trim().toLowerCase().replace(/[_,]/g, "");
  const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(text);
  const n = match ? Math.round(Number(match[1]) * { "": 1, k: 1_000, m: 1_000_000 }[match[2]]) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`The allowance must be a whole number of output tokens, like 2000000 or 2m (got "${raw}").`);
  }
  return n;
}

/** A SQL string literal. */
export function sqlString(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

/** Set the allowance of every account with this email, or create a placeholder if there is none. */
export function grantSql(email, allowance) {
  const e = sqlString(normalizeEmail(email));
  const n = parseAllowance(allowance);
  return [
    `UPDATE users SET allowance = ${n} WHERE email = ${e}`,
    `INSERT INTO users (email, created_at, allowance) SELECT ${e}, ${NOW_SQL}, ${n} WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ${e})`,
    `SELECT ${SHOW_COLUMNS} FROM users WHERE email = ${e}`,
  ].join("; ");
}

export function revokeSql(email) {
  const e = sqlString(normalizeEmail(email));
  return [`UPDATE users SET allowance = 0 WHERE email = ${e}`, `SELECT ${SHOW_COLUMNS} FROM users WHERE email = ${e}`].join("; ");
}

export function listSql() {
  return (
    "SELECT u.id, u.email, u.name, u.allowance, CASE WHEN u.google_sub IS NULL THEN 'not yet' ELSE 'yes' END AS signed_in, " +
    `(SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ${NOW_SQL}) AS sessions, u.created_at ` +
    "FROM users u ORDER BY u.id"
  );
}

/** wrangler's arguments to run `sql` on the remote or local D1. */
export function d1Args(sql, target) {
  if (target !== "remote" && target !== "local") throw new Error('The target is "remote" or "local".');
  return ["d1", "execute", DATABASE, "--command", sql, `--${target}`];
}

/** Quote for POSIX shells. Double quotes when that is safe, since SQL is full of single quotes. */
export function shellQuote(text) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  if (!/["$`\\!]/.test(text)) return `"${text}"`;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const GATEWAY_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");

const USAGE = `Usage:
  node ${scriptRef()} <email> <tokens>   grant or change a monthly output-token allowance (2000000, 2m, 500k)
  node ${scriptRef()} revoke <email>     set the allowance to 0; the account and its sign-in stay
  node ${scriptRef()} list               list accounts

Options:
  --run remote | local   run the command with wrangler instead of printing it
  --persist-to DIR       with --run local: the state folder \`wrangler dev\` uses, if not the default`;

function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || positional.length === 0) {
    console.log(USAGE);
    process.exit(flags.help ? 0 : 1);
  }
  for (const key of Object.keys(flags)) {
    if (!["help", "run", "persist-to"].includes(key)) fail(`Unknown option --${key}.`);
  }
  if (flags.run !== undefined && flags.run !== "remote" && flags.run !== "local") fail("--run takes remote or local.");
  if (flags["persist-to"] !== undefined && flags.run !== "local") fail("--persist-to goes with --run local.");

  let sql;
  let what;
  let after = "";
  try {
    if (positional[0] === "list") {
      if (positional.length !== 1) fail("list takes no arguments.");
      sql = listSql();
      what = "List accounts";
      const month = new Date().toISOString().slice(0, 7);
      after = `An account's usage this month is in KV, under its id:

  ${wrangler(["kv", "key", "get", "--binding", "USAGE", `tok:user:<id>:${month}`, "--text", "--remote"])}`;
    } else if (positional[0] === "revoke") {
      if (positional.length !== 2) fail("revoke takes exactly one email address.");
      const email = normalizeEmail(positional[1]);
      sql = revokeSql(email);
      what = `Revoke the allowance of ${email}`;
      after = `The next request from ${email} gets a 403 ("This account has no Komposit allowance yet.").
The account stays, so they stay signed in; grant again to restore it.`;
    } else {
      if (positional.length !== 2) fail("Pass an email address and a number of output tokens: jane@example.com 2m");
      const email = normalizeEmail(positional[0]);
      const allowance = parseAllowance(positional[1]);
      sql = grantSql(email, allowance);
      what = `Grant ${email} ${allowance.toLocaleString("en-US")} output tokens a month`;
      after = `If ${email} hasn't signed in yet, this makes a placeholder row.
Their first sign-in claims it, but only if Google says that email is verified.
Gmail addresses must match exactly, dots included; \`list\` shows the address
each account signed in with. The new allowance applies from their next request,
and this month's usage so far still counts against it.`;
    }
  } catch (err) {
    fail(err.message);
  }

  if (flags.run) {
    const args = d1Args(sql, flags.run);
    if (flags["persist-to"]) args.push("--persist-to", path.resolve(flags["persist-to"]));
    process.exit(runWrangler(args));
  }

  console.log(`${what}.

On the production D1:

  ${wrangler(d1Args(sql, "remote"))}

Or on the local D1 that \`npm run dev\` uses:

  ${wrangler(d1Args(sql, "local"))}

${after}`);
}

/** Run wrangler from gateway/ with this checkout's own copy. Returns its exit code. */
function runWrangler(args) {
  const bin = path.join(GATEWAY_DIR, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!existsSync(bin)) fail(`Wrangler isn't installed. Run \`npm install\` in ${path.relative(process.cwd(), GATEWAY_DIR) || "."} first.`);
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: GATEWAY_DIR, stdio: "inherit" });
  return result.status ?? 1;
}

/** A printed wrangler command that works from the current directory (wrangler must run inside gateway/). */
function wrangler(args) {
  const rel = path.relative(process.cwd(), GATEWAY_DIR);
  const cmd = `npx wrangler ${args.map(shellQuote).join(" ")}`;
  return rel === "" ? cmd : `(cd ${shellQuote(rel)} && ${cmd})`;
}

function scriptRef() {
  return path.relative(process.cwd(), SCRIPT_PATH) || SCRIPT_PATH;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) fail(`Missing a value for --${key}.`);
      flags[key] = value;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function fail(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main(process.argv.slice(2));
}
