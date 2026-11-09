#!/usr/bin/env node
// Mint or revoke komposit-gateway invite codes.
//
//   node gateway/scripts/mint-invite.mjs "Name" [--daily 300] [--monthly-output 2000000] [--models a,b]
//   node gateway/scripts/mint-invite.mjs revoke <code-or-hash> [--name "Name"]
//
// This script writes nothing. It prints the code to hand out and the exact
// wrangler commands that store (or revoke) the invite record in KV. The gateway
// keeps only the SHA-256 hash of a code, so the printed code is the only copy.
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567"; // RFC 4648 alphabet, lowercase
export const CODE_PREFIX = "kp_";

/** "kp_" + 24 random base32 characters (120 bits). */
export function generateInviteCode() {
  // 256 is a multiple of 32, so taking the low 5 bits of each byte is unbiased.
  return CODE_PREFIX + Array.from(randomBytes(24), (byte) => BASE32[byte & 31]).join("");
}

/** The KV key suffix for a code: lowercase hex SHA-256 of the exact code string. */
export function hashInviteCode(code) {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const GATEWAY_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");

const USAGE = `Usage:
  node ${scriptRef()} "Name" [--daily 300] [--monthly-output 2000000] [--models a,b]
  node ${scriptRef()} revoke <code-or-hash> [--name "Name"]

Mint options (omit one to use the gateway's default from wrangler.toml):
  --daily N            requests per UTC day          (DEFAULT_DAILY_REQUESTS)
  --monthly-output N   output tokens per UTC month   (DEFAULT_MONTHLY_OUTPUT_TOKENS)
  --models a,b         models this invite may call   (ALLOWED_MODELS); replaces the default list

Revoke options:
  --name "Name"        name to keep on the disabled record`;

function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help || positional.length === 0) {
    console.log(USAGE);
    process.exit(flags.help ? 0 : 1);
  }
  if (positional[0] === "revoke") {
    allowFlags(flags, ["name"]);
    if (positional.length !== 2) fail("revoke takes exactly one invite code or hash.");
    revoke(positional[1], flags);
  } else {
    allowFlags(flags, ["daily", "monthly-output", "models"]);
    if (positional.length !== 1) fail('Pass the invitee\'s name as one argument, quoted if it has spaces: "Jane Doe".');
    mint(positional[0], flags);
  }
}

function mint(rawName, flags) {
  const name = rawName.trim();
  if (!name) fail("The name must not be empty.");

  const record = { name };
  if (flags.daily !== undefined) record.dailyRequests = parseCount(flags.daily, "--daily");
  if (flags["monthly-output"] !== undefined) {
    record.monthlyOutputTokens = parseCount(flags["monthly-output"], "--monthly-output");
  }
  if (flags.models !== undefined) {
    const models = flags.models.split(",").map((m) => m.trim()).filter(Boolean);
    if (!models.length) fail("--models needs at least one model id.");
    record.models = models;
  }
  record.created = new Date().toISOString().slice(0, 10);

  const code = generateInviteCode();
  const hash = hashInviteCode(code);
  const key = `inv:${hash}`;
  const value = JSON.stringify(record);

  const limits = [
    record.dailyRequests !== undefined ? `${fmt(record.dailyRequests)} requests/day` : "default requests/day",
    record.monthlyOutputTokens !== undefined
      ? `${fmt(record.monthlyOutputTokens)} output tokens/month`
      : "default output tokens/month",
    record.models ? `models: ${record.models.join(", ")}` : "default models",
  ];

  console.log(`Invite for ${name} (${limits.join("; ")})

Give ${name} this code. It is shown only once; the gateway stores only its hash.

  ${code}

Store the invite in production KV:

  ${wrangler(`kv key put --binding INVITES "${key}" ${shellQuote(value)} --remote`)}

Or in the local KV that \`npm run dev\` uses:

  ${wrangler(`kv key put --binding INVITES "${key}" ${shellQuote(value)} --local`)}

To revoke it later (this line holds only the hash, so it is safe to keep in your notes):

  node ${scriptRef()} revoke ${hash} --name ${shellQuote(name)}`);
}

function revoke(target, flags) {
  const hash = /^[0-9a-f]{64}$/i.test(target) ? target.toLowerCase() : hashInviteCode(target.trim());
  const key = `inv:${hash}`;
  const record = JSON.stringify({
    name: flags.name?.trim() || "revoked",
    disabled: true,
    revoked: new Date().toISOString().slice(0, 10),
  });

  console.log(`Revoke ${key}

Disable it (the record stays, marked disabled; this replaces its limits):

  ${wrangler(`kv key put --binding INVITES "${key}" ${shellQuote(record)} --remote`)}

Or delete the record outright:

  ${wrangler(`kv key delete --binding INVITES "${key}" --remote`)}

To look at the current record first:

  ${wrangler(`kv key get --binding INVITES "${key}" --text --remote`)}

Use --local instead of --remote for the local dev KV. The code stops working
within about a minute (KV read caching). Usage counters in USAGE are kept.`);
}

// ---------------------------------------------------------------------------

/** A wrangler command that works from the current directory (wrangler must run inside gateway/). */
function wrangler(args) {
  const rel = path.relative(process.cwd(), GATEWAY_DIR);
  const cmd = `npx wrangler ${args}`;
  return rel === "" ? cmd : `(cd ${shellQuote(rel)} && ${cmd})`;
}

function scriptRef() {
  return path.relative(process.cwd(), SCRIPT_PATH) || SCRIPT_PATH;
}

/** Quote for POSIX shells: single quotes, with embedded single quotes escaped. */
function shellQuote(text) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
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

function allowFlags(flags, allowed) {
  for (const key of Object.keys(flags)) {
    if (key !== "help" && !allowed.includes(key)) fail(`Unknown option --${key}.`);
  }
}

function parseCount(value, flag) {
  const n = Number(String(value).replace(/[_,]/g, ""));
  if (!Number.isSafeInteger(n) || n < 0) fail(`${flag} must be a whole number of zero or more (got "${value}").`);
  return n;
}

function fmt(n) {
  return n.toLocaleString("en-US");
}

function fail(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main(process.argv.slice(2));
}
