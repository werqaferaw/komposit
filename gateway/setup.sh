#!/bin/bash
# One-time setup and deploy of the invite gateway. Run it yourself, from
# anywhere; it needs your Cloudflare login and asks for the Anthropic key.
#
#   gateway/setup.sh
#
# 1. Shows which Cloudflare account Wrangler is signed in to (it must be the
#    one that owns werq.dev; switch with `npx wrangler logout && npx wrangler login`).
# 2. Creates the INVITES and USAGE KV namespaces (or finds them if they exist)
#    and writes their ids into wrangler.toml.
# 3. Stores ANTHROPIC_API_KEY as a Worker secret (Wrangler prompts; the key
#    never lands in a file or your shell history).
# 4. Deploys, which also creates gateway.komposit.werq.dev (DNS + certificate).
# 5. Checks /health.
# Safe to re-run: existing namespaces are reused; the secret step can be skipped.
set -euo pipefail
cd "$(dirname "$0")"
[ -d node_modules ] || npm install --no-audit --no-fund
W="npx --no-install wrangler"

echo "== Cloudflare account"
$W whoami 2>&1 | grep -E "associated with|Account Name|│ .*│" | head -6
read -r -p "Is this the account that owns werq.dev? [y/N] " yes
[ "$yes" = "y" ] || [ "$yes" = "Y" ] || { echo "Switch with: npx wrangler logout && npx wrangler login"; exit 1; }

ns_id() { # binding -> namespace id (created if missing)
  local b="$1" id
  id="$($W kv namespace list 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const want = process.argv[1];
        const hit = JSON.parse(s).find((n) => n.title === want || n.title.endsWith("-" + want));
        if (hit) process.stdout.write(hit.id);
      } catch {}
    });' "$b")"
  if [ -z "$id" ]; then
    id="$($W kv namespace create "$b" 2>&1 | grep -oE 'id"? ?[=:] ?"[0-9a-f]{32}"' | grep -oE '[0-9a-f]{32}' | head -1)"
  fi
  [ -n "$id" ] || { echo "couldn't create or find the $b namespace" >&2; exit 1; }
  echo "$id"
}

echo "== KV namespaces"
INV="$(ns_id INVITES)"; USE="$(ns_id USAGE)"
echo "   INVITES $INV"; echo "   USAGE   $USE"
node -e '
  const fs = require("fs"); let t = fs.readFileSync("wrangler.toml", "utf8");
  t = t.replace(/id = "TODO-replace-with-INVITES-namespace-id"/, `id = "${process.argv[1]}"`)
       .replace(/id = "TODO-replace-with-USAGE-namespace-id"/, `id = "${process.argv[2]}"`);
  fs.writeFileSync("wrangler.toml", t);' "$INV" "$USE"
grep -q "TODO-replace" wrangler.toml && { echo "wrangler.toml still has a placeholder id" >&2; exit 1; }

echo "== Anthropic key (a dedicated key in its own Console workspace, with a monthly spend limit)"
read -r -p "Store or replace ANTHROPIC_API_KEY now? [y/N] " k
if [ "$k" = "y" ] || [ "$k" = "Y" ]; then $W secret put ANTHROPIC_API_KEY; fi

echo "== deploy"
$W deploy

echo "== health"
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  out="$(curl -s --max-time 10 https://gateway.komposit.werq.dev/health || true)"
  if echo "$out" | grep -q '"ok":true'; then echo "   $out"; break; fi
  [ "$i" = 12 ] && { echo "   not healthy yet: $out (the certificate can take a few minutes; re-run: curl https://gateway.komposit.werq.dev/health)"; }
  sleep 10
done
echo "== next: mint your own invite and test it (docs/releasing.md)"
echo "   node scripts/mint-invite.mjs \"Me\"   then run the --remote command it prints"
