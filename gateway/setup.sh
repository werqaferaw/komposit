#!/bin/bash
# One-time setup and deploy of the gateway. Safe to re-run: it finds what
# already exists. Run it yourself, from anywhere.
#
#   gateway/setup.sh                    asks before using the account; offers to store each secret
#   gateway/setup.sh --yes              asks nothing (for a shell without a terminal);
#                                       secrets come only from these environment variables:
#                                         GATEWAY_ANTHROPIC_API_KEY  -> Worker secret ANTHROPIC_API_KEY
#                                         GOOGLE_CLIENT_SECRET       -> Worker secret GOOGLE_CLIENT_SECRET
#   gateway/setup.sh --yes --no-deploy  only steps 1-4: KV, D1 and its migrations; no secrets, no deploy
#
#  1. Shows which Cloudflare account Wrangler is signed in to. It must be the one
#     that owns werq.dev (switch with `npx wrangler logout && npx wrangler login`).
#  2. Finds or creates the KV namespaces komposit-gateway-INVITES and
#     komposit-gateway-USAGE, and writes their ids into wrangler.toml.
#  3. Finds or creates the D1 database komposit-gateway, writes its id into
#     wrangler.toml, and applies migrations/ to it.
#  4. Checks GOOGLE_CLIENT_ID in wrangler.toml. While it is the placeholder,
#     sign-in stays off (GOOGLE_CLIENT_ID in the environment replaces it).
#  5. Stores ANTHROPIC_API_KEY and GOOGLE_CLIENT_SECRET as Worker secrets. Values
#     are piped to `wrangler secret put` (or typed at its hidden prompt) and are
#     never printed or written to a file. The Anthropic key is read from
#     GATEWAY_ANTHROPIC_API_KEY, not ANTHROPIC_API_KEY, so a personal key in
#     your shell is never picked up by accident.
#  6. Deploys, which also creates gateway.komposit.werq.dev (DNS + certificate).
#  7. Checks /health, including whether sign-in is on.
#
# For your own deployment: GATEWAY_URL=https://your-gateway-host (default
# https://gateway.komposit.werq.dev). WRANGLER overrides the wrangler command.
set -euo pipefail
cd "$(dirname "$0")"

YES=0
DEPLOY=1
for arg in "$@"; do
  case "$arg" in
    -y | --yes) YES=1 ;;
    --no-deploy) DEPLOY=0 ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done
INTERACTIVE=0
[ -t 0 ] && INTERACTIVE=1

[ -d node_modules ] || npm install --no-audit --no-fund
W="${WRANGLER:-npx --no-install wrangler}"
GATEWAY_URL="${GATEWAY_URL:-https://gateway.komposit.werq.dev}"
export WRANGLER_SEND_METRICS=false
DB_NAME="komposit-gateway"

ask() { # "question" -> success only for an explicit yes typed at a terminal
  [ "$INTERACTIVE" = 1 ] || return 1
  local answer
  read -r -p "$1 [y/N] " answer || return 1
  [ "$answer" = "y" ] || [ "$answer" = "Y" ]
}

wr() { # wrangler for a step that may ask something: at a terminal it can; otherwise it takes its default
  if [ "$INTERACTIVE" = 1 ]; then $W "$@"; else $W "$@" </dev/null; fi
}

json_find() { # <field to print> <field to match> <value>, reading a JSON array on stdin
  node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const [field, key, want] = process.argv.slice(1);
        const hit = JSON.parse(s.slice(s.indexOf("["))).find((item) => item[key] === want);
        if (hit) process.stdout.write(String(hit[field]));
      } catch {}
    });' "$@"
}

toml_replace() { # <placeholder> <value>: replaces "<placeholder>" in wrangler.toml
  node -e '
    const fs = require("fs"); const [from, to] = process.argv.slice(1);
    const text = fs.readFileSync("wrangler.toml", "utf8");
    fs.writeFileSync("wrangler.toml", text.split(`"${from}"`).join(`"${to}"`));' "$1" "$2"
}

toml_set_var() { # <NAME> <value>: rewrites the NAME = "..." line under [vars]
  node -e '
    const fs = require("fs"); const [name, value] = process.argv.slice(1);
    const text = fs.readFileSync("wrangler.toml", "utf8");
    const line = new RegExp(`^${name} = ".*"$`, "m");
    if (!line.test(text)) { console.error(`wrangler.toml has no ${name} line`); process.exit(1); }
    fs.writeFileSync("wrangler.toml", text.replace(line, `${name} = ${JSON.stringify(value)}`));' "$1" "$2"
}

echo "== 1. Cloudflare account"
$W whoami </dev/null 2>&1 | grep -E "associated with|Account Name|│ .*│" | head -6 || true
if [ "$YES" = 1 ]; then
  echo "   --yes: using this account."
elif ! ask "Is this the account that owns werq.dev?"; then
  if [ "$INTERACTIVE" = 1 ]; then
    echo "Switch with: npx wrangler logout && npx wrangler login"
  else
    echo "No terminal to ask at. Check the account above, then re-run with --yes."
  fi
  exit 1
fi

kv_id() { # <title> -> namespace id; creates the namespace if the account has none with exactly that title
  local title="$1" id out
  id="$($W kv namespace list </dev/null 2>/dev/null | json_find id title "$title")"
  if [ -z "$id" ]; then
    if ! out="$($W kv namespace create "$title" </dev/null 2>&1)"; then
      echo "$out" >&2
      echo "Couldn't create the KV namespace $title." >&2
      exit 1
    fi
    id="$($W kv namespace list </dev/null 2>/dev/null | json_find id title "$title")"
  fi
  [ -n "$id" ] || { echo "Couldn't find the KV namespace $title." >&2; exit 1; }
  echo "$id"
}

echo "== 2. KV namespaces"
INV="$(kv_id komposit-gateway-INVITES)"
USE="$(kv_id komposit-gateway-USAGE)"
echo "   INVITES  komposit-gateway-INVITES  $INV"
echo "   USAGE    komposit-gateway-USAGE    $USE"
toml_replace "TODO-replace-with-INVITES-namespace-id" "$INV"
toml_replace "TODO-replace-with-USAGE-namespace-id" "$USE"

echo "== 3. D1 database"
D1="$($W d1 list --json </dev/null 2>/dev/null | json_find uuid name "$DB_NAME")"
if [ -z "$D1" ]; then
  if ! out="$($W d1 create "$DB_NAME" </dev/null 2>&1)"; then
    echo "$out" >&2
    echo "Couldn't create the D1 database $DB_NAME." >&2
    exit 1
  fi
  D1="$($W d1 list --json </dev/null 2>/dev/null | json_find uuid name "$DB_NAME")"
fi
[ -n "$D1" ] || { echo "Couldn't find the D1 database $DB_NAME." >&2; exit 1; }
echo "   DB       $DB_NAME          $D1"
toml_replace "TODO-replace-with-D1-database-id" "$D1"

if grep -qE '^(id|database_id) = "TODO-' wrangler.toml; then
  echo "wrangler.toml still has a placeholder id." >&2
  exit 1
fi
for id in "$INV" "$USE" "$D1"; do
  grep -q "\"$id\"" wrangler.toml || {
    echo "wrangler.toml names a different KV namespace or database than the ones above ($id). Fix wrangler.toml, then re-run." >&2
    exit 1
  }
done
# At a terminal, Wrangler asks before applying; otherwise it goes ahead.
wr d1 migrations apply DB --remote

echo "== 4. Google sign-in client id"
CLIENT_ID="$(sed -n 's/^GOOGLE_CLIENT_ID = "\(.*\)"$/\1/p' wrangler.toml)"
# A client id in the environment replaces the one in wrangler.toml (your own deployment).
if [ -n "${GOOGLE_CLIENT_ID:-}" ] && [ "$GOOGLE_CLIENT_ID" != "$CLIENT_ID" ]; then CLIENT_ID=""; fi
case "$CLIENT_ID" in
  "" | TODO*)
    if [ -n "${GOOGLE_CLIENT_ID:-}" ]; then
      if ! [[ "$GOOGLE_CLIENT_ID" =~ ^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$ ]]; then
        echo "GOOGLE_CLIENT_ID doesn't look like a Google OAuth client id (...apps.googleusercontent.com)." >&2
        exit 1
      fi
      toml_set_var GOOGLE_CLIENT_ID "$GOOGLE_CLIENT_ID"
      echo "   GOOGLE_CLIENT_ID written into wrangler.toml from the environment: $GOOGLE_CLIENT_ID"
    else
      echo "   GOOGLE_CLIENT_ID isn't set in wrangler.toml (or is the placeholder), so sign-in stays off."
      echo "   Invites work as usual. Put the client id from Google Cloud into wrangler.toml to turn it on."
    fi
    ;;
  *) echo "   $CLIENT_ID" ;;
esac

if [ "$DEPLOY" = 0 ]; then
  cat <<'EOF'
== stopped before the secrets and the deploy (--no-deploy). Next, from gateway/:
   printf '%s' "$GATEWAY_ANTHROPIC_API_KEY" | npx wrangler secret put ANTHROPIC_API_KEY
   printf '%s' "$GOOGLE_CLIENT_SECRET" | npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler deploy
   (or re-run gateway/setup.sh --yes with those two variables set)
EOF
  exit 0
fi

put_secret() { # <secret name> <environment variable holding it>
  local name="$1" var="$2"
  if [ -n "${!var:-}" ]; then
    # printf is a shell builtin: the value goes down the pipe, never onto a command line.
    printf '%s' "${!var}" | $W secret put "$name"
  elif ask "Store or replace $name now? (Wrangler asks for it without showing it)"; then
    $W secret put "$name"
  else
    echo "   $name left as it is. To set it: printf '%s' \"\$$var\" | npx wrangler secret put $name"
  fi
}

echo "== 5. Secrets"
echo "   ANTHROPIC_API_KEY: a dedicated key in its own Console workspace, with a monthly spend limit."
put_secret ANTHROPIC_API_KEY GATEWAY_ANTHROPIC_API_KEY
echo "   GOOGLE_CLIENT_SECRET: from the same Google Cloud OAuth client as GOOGLE_CLIENT_ID."
put_secret GOOGLE_CLIENT_SECRET GOOGLE_CLIENT_SECRET

echo "== 6. Deploy"
wr deploy

echo "== 7. Health"
out=""
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  out="$(curl -s --max-time 10 "$GATEWAY_URL/health" || true)"
  if echo "$out" | grep -q '"ok":true'; then echo "   $out"; break; fi
  [ "$i" = 12 ] && echo "   Not healthy yet: $out (the certificate can take a few minutes; re-check with: curl $GATEWAY_URL/health)"
  sleep 10
done
if echo "$out" | grep -q '"signIn":true'; then
  echo "   Sign-in with Google is on. Grant someone an allowance: node scripts/grant.mjs <email> 2m (then run the --remote command it prints)"
else
  echo "   Sign-in with Google is off; signInMissing above says what it still needs. Invites work either way."
fi
echo "== next: mint your own invite and test it (docs/releasing.md)"
echo "   node scripts/mint-invite.mjs \"Me\"   then run the --remote command it prints"
