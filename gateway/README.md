# komposit-gateway

A Cloudflare Worker that lets people you invite use your Anthropic API key without the key ever leaving the Worker.

Testers run the Komposit app with an invite code where an API key would go:

```js
new Anthropic({ baseURL: "https://gateway.komposit.werq.dev", apiKey: "kp_..." })
```

The gateway checks the invite code against Workers KV and enforces that invite's limits. It forwards the request to `https://api.anthropic.com/v1/messages` with your key, streams the response straight back, and meters token usage from the response as it passes through. To the SDK it looks exactly like the Anthropic API, including error shapes, so `AuthenticationError`, `RateLimitError` and the rest work as usual.

```
tester's app ──(invite code)──▶ gateway ──(your key)──▶ api.anthropic.com
                                   │
                    KV INVITES: who may call, their limits
                    KV USAGE:   requests per day, tokens per month
```

## Files

| Path | What it is |
| --- | --- |
| `src/index.js` | The Worker. ES module, no dependencies. |
| `wrangler.toml` | Name, KV bindings (placeholder ids), vars, the custom-domain route. |
| `scripts/mint-invite.mjs` | Prints a new invite code and the `wrangler` commands that store or revoke it. |
| `test/mock-upstream.mjs` | A fake Anthropic API (SSE and JSON) that records what it receives. |
| `test/gateway.test.mjs` | End-to-end tests against `wrangler dev --local`. |

## Routes

| Route | Purpose |
| --- | --- |
| `POST /v1/messages` | The proxy. Same request and response as the Messages API, streaming included. |
| `GET /v1/me` | `{ name, limits, usage }` for the calling invite code. The app uses it to check a code. |
| `GET /health` | `{"ok":true}`, or `503 {"ok":false,"missing":[...]}` if the secret or a KV binding is missing. |

Every other route returns a 404 in the Anthropic error shape. There is no CORS; the gateway is meant for server-to-server calls only.

The invite code is read from `x-api-key`, or from `Authorization: Bearer <code>`. Anthropic SDK 1.x sends API keys the second way. An unknown, revoked or missing code gets:

```json
{"type":"error","error":{"type":"authentication_error","message":"Invalid invite code"}}
```

`GET /v1/me` answers like this:

```json
{
  "name": "Jane Doe",
  "limits": { "dailyRequests": 300, "monthlyOutputTokens": 2000000, "maxTokens": 64000,
              "models": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] },
  "usage": {
    "today":     { "date": "2026-11-08", "requests": 12, "resetsAt": "2026-11-09T00:00:00.000Z" },
    "thisMonth": { "month": "2026-11", "outputTokens": 48211, "inputTokens": 30544,
                   "cacheCreationInputTokens": 9120, "cacheReadInputTokens": 402233,
                   "resetsAt": "2026-12-01T00:00:00.000Z" }
  }
}
```

## Setup (once)

Run everything from `gateway/`. Wrangler 4 needs Node 22 or newer.

1. **Install.** `npm install`. This installs the pinned `wrangler`, plus the Anthropic SDK, which only the tests use.
2. **Log in to Cloudflare.** `npx wrangler login`, or set `CLOUDFLARE_API_TOKEN`. Use the account that owns the `werq.dev` zone.
3. **Pick a plan.** Workers Paid ($5/month) is strongly recommended. Each proxied request costs 2 KV writes (one for the request count, one for the token totals). The Free plan allows 1,000 KV writes a day, which is about 500 requests across all testers, and Komposit's agent loop makes one request per tool call. Past that, KV writes fail. The gateway keeps serving requests, but it stops counting them, so the limits stop working until the next UTC day. The Free plan also caps CPU time at 10 ms per request.
4. **Create the KV namespaces** and paste each printed `id` into `wrangler.toml` in place of the `TODO-replace-with-...` values:
   ```sh
   npx wrangler kv namespace create INVITES
   npx wrangler kv namespace create USAGE
   ```
5. **Make a dedicated Anthropic API key.** Create it in its own workspace in the Claude Console and give that workspace a monthly spend limit. That limit is the one hard ceiling on what invitees can cost you (see Security). Then store the key as a secret:
   ```sh
   npx wrangler secret put ANTHROPIC_API_KEY
   ```
   Wrangler prompts for the value, so it never appears in your shell history. `secret put` deploys right away. If the Worker doesn't exist yet, Wrangler offers to create it.
6. **Check the model list.** Requests for any model that isn't in `ALLOWED_MODELS` (`wrangler.toml`) get a 400. The default list is `claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5`. Make sure it covers every model the app sends.

## Deploy

```sh
npx wrangler deploy
```

That publishes the gateway at `https://komposit-gateway.<your-subdomain>.workers.dev`. It is also served from the custom domain in the `[[routes]]` block of `wrangler.toml` (`gateway.komposit.werq.dev`; change or remove it for your own deployment). Wrangler creates the DNS record and a certificate for that exact hostname. The certificate matters because Universal SSL does not cover a two-level subdomain like this one. The hostname must not already have a CNAME record. Set `workers_dev = false` later if you want only one public URL.

Smoke test, using an invite code minted for yourself:

```sh
curl https://gateway.komposit.werq.dev/health
curl https://gateway.komposit.werq.dev/v1/me -H "x-api-key: kp_..."
curl https://gateway.komposit.werq.dev/v1/messages -H "x-api-key: kp_..." \
  -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-haiku-5-5","max_tokens":32,"messages":[{"role":"user","content":"Say hi"}]}'
```

Follow live logs with `npx wrangler tail`. Workers Logs (enabled in `wrangler.toml`) also keeps them for a few days in the dashboard.

## Invites

### Mint

```sh
node gateway/scripts/mint-invite.mjs "Jane Doe"                      # gateway defaults
node gateway/scripts/mint-invite.mjs "Jane Doe" --daily 100 --monthly-output 500000
node gateway/scripts/mint-invite.mjs "Jane Doe" --models claude-haiku-5-5,claude-sonnet-5-5
# or, from gateway/:  npm run mint -- "Jane Doe" --daily 100
```

The script writes nothing. It prints:

- the code to give the person (`kp_` plus 24 random base32 characters, 120 bits). It is shown once, because KV stores only its SHA-256 hash;
- the exact `npx wrangler kv key put --binding INVITES "inv:<hash>" '<json>' --remote` command that activates it. Run that one;
- a `--local` variant, for the local KV that `npm run dev` uses;
- a `revoke` line that holds only the hash. Keep it in your notes instead of the code.

The record looks like `{"name":"Jane Doe","dailyRequests":100,"created":"2026-11-08"}`. Fields left out fall back to the gateway defaults. A `models` list on the record replaces `ALLOWED_MODELS` for that invite. Use it to narrow an invite to cheaper models, or to grant one person an extra model.

The tester then sets the base URL `https://gateway.komposit.werq.dev` and uses the code as the API key. `GET /v1/me` tells the app whether the code works.

### Change, inspect, revoke

```sh
node gateway/scripts/mint-invite.mjs revoke <hash-or-code> --name "Jane Doe"
```

This prints three commands:

- one that overwrites the record with `{"name": ..., "disabled": true}`;
- one that deletes the record;
- one that reads the current record.

A revoked code stops working within about a minute, because KV reads are cached at the edge for up to 60 s. Its usage counters stay in `USAGE`.

To change an invite's limits, run the `kv key put` again for the same `inv:<hash>` key with the new JSON. Other useful commands:

```sh
npx wrangler kv key list --binding INVITES --remote                      # all invites (hashes)
npx wrangler kv key get  --binding INVITES "inv:<hash>" --text --remote  # one record
npx wrangler kv key get  --binding USAGE "tok:<hash>:2026-11" --text --remote
```

## How the limits work

| Limit | Default (var) | Stored in `USAGE` | Counted |
| --- | --- | --- | --- |
| Requests per UTC day | `DEFAULT_DAILY_REQUESTS` = 300 | `req:<hash>:<YYYY-MM-DD>` | When a request arrives, once it passes validation and before it is forwarded |
| Output tokens per UTC month | `DEFAULT_MONTHLY_OUTPUT_TOKENS` = 2,000,000 | `tok:<hash>:<YYYY-MM>` | When the response finishes, from the `usage` Anthropic reports |
| `max_tokens` per request | `MAX_TOKENS_CAP` = 64000 | (none) | Larger values are lowered to the cap before forwarding |
| Models | `ALLOWED_MODELS` | (none) | Anything else is a 400 `invalid_request_error` |

- Both limits are checked before a request is forwarded. At the limit, the tester gets a `429 rate_limit_error` whose message names the limit and when it resets. The response carries `retry-after` (seconds until the reset) and `x-should-retry: false`. The latter matters: without it, Anthropic SDK 1.x would honour `retry-after` and wait until midnight.
- Token usage is read as the response streams past. For SSE, that is `message_start.message.usage` plus the cumulative `message_delta.usage`. For JSON, it is `usage`. When the API itemises server-side steps (refusal fallbacks, compaction) in `usage.iterations`, those are summed. The totals land in KV inside `ctx.waitUntil`, so they never delay the response. Input, cache-write and cache-read tokens are recorded next to output tokens and shown in `/v1/me`, but only output tokens have a cap.
- If the client disconnects mid-stream (the app's Stop button), the gateway cancels the upstream request, so generation stops at once, and it records the usage seen so far.
- Requests that fail validation (401, 400, 413, 429) don't count. Upstream errors such as 529 overloaded do count as requests, but they have no tokens.
- These are soft caps. KV is eventually consistent and accepts about one write per second per key. Concurrent requests can read the same count, and a request that crosses the token budget still finishes. Expect overshoot of a few requests or one response's worth of tokens, more if one invite is used from several regions at once. Daily keys expire after 8 days, and monthly keys after about 13 months.
- Per-invite `dailyRequests` / `monthlyOutputTokens` override the defaults. `0` blocks the invite. For "unlimited", use a very large number.

The request body is otherwise forwarded byte-for-byte. `fallbacks`, `thinking`, `output_config`, `cache_control`, tools and everything else are untouched. The only time the gateway re-serialises the body is to lower `max_tokens`. Only `anthropic-version` and `anthropic-beta` are copied from the client's headers, and the query string (`?beta=true` from older SDKs) is kept.

## Local development and tests

```sh
npm test
```

This needs no Cloudflare account and makes no calls to Anthropic. It takes about 15 seconds:

1. It starts `test/mock-upstream.mjs` on a free port.
2. It seeds a throwaway local KV under `.wrangler/test-state-*/` with `wrangler kv bulk put --local`, the same tool an operator uses.
3. It runs `wrangler dev --local` (miniflare) with `UPSTREAM_BASE` pointed at the mock and a fake `ANTHROPIC_API_KEY`, then runs the 16 tests in `test/gateway.test.mjs`.
4. It shuts everything down and deletes the state.

The tests cover streaming pass-through, owner key versus invite, Bearer auth, the `max_tokens` clamp, the model check, both 429s, `/v1/me`, usage recording, client disconnects, the official SDK, the mint and revoke commands, and that no logs contain codes, keys or bodies. Set `DEBUG_GATEWAY=1` to see the Worker's output, or `KEEP_TEST_STATE=1` to keep the local KV.

The tests seed KV with `wrangler kv ... --local` rather than through a dev-only HTTP route. That way the deployed Worker has no seeding code path that a stray variable could switch on.

To poke at it by hand:

```sh
node test/mock-upstream.mjs 8788      # in one terminal: fake Anthropic, logs what it receives
npx wrangler dev --local --var UPSTREAM_BASE:http://127.0.0.1:8788 --var ANTHROPIC_API_KEY:dummy
node scripts/mint-invite.mjs "Me"     # run the printed --local command, then call localhost:8787
```

To use the real API locally instead, put `ANTHROPIC_API_KEY=...` in `gateway/.dev.vars` (git-ignored) and run `npm run dev`.

## Security

- **The key stays in the Worker.** It exists only as a Worker secret. It is sent only to `UPSTREAM_BASE`, is never returned to clients, and is never logged.
- **Client credentials never reach Anthropic.** Upstream headers are built from scratch. The client's `x-api-key` / `Authorization` (the invite code), `x-stainless-*` and everything else are dropped. Only `anthropic-version` and `anthropic-beta` are copied.
- **Responses are filtered.** Only `content-type`, `request-id`, `retry-after`, `retry-after-ms` and `x-should-retry` come back. The headers that describe your account, `anthropic-organization-id` and `anthropic-ratelimit-*`, are stripped.
- **Invite codes are stored only as hashes.** KV holds only the SHA-256 of each code. Codes carry 120 random bits, so they can't be guessed. If you're worried about request floods, add a Cloudflare WAF rate-limiting rule for the hostname.
- **Logs are metadata only.** There is one JSON line per request: invite name, model, status, token counts and timing. Request and response bodies, codes and keys are never logged, and the test suite checks this. Cloudflare redacts headers such as `x-api-key` and `authorization` in Workers Logs.
- **Revocation takes about a minute**, because of KV edge caching.
- **What the gateway does not police.** Input tokens are recorded but not capped. Paid add-ons that a request can turn on are passed through: fast mode, web search, code execution. So are model names nested inside the body, such as an explicit `fallbacks` list or an advisor tool. The spend limit on the dedicated Console workspace (Setup, step 5) is the backstop for all of this, and for the soft-cap overshoot above.
- **KV failures fail open.** If KV rejects a counter write (for example, the Free plan's daily write limit), the request still goes through and the error is logged as `kv_write_failed`. If the invite lookup itself fails, requests get a 503.
