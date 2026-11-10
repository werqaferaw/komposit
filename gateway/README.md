# komposit-gateway

A Cloudflare Worker that lets people you invite use your Anthropic API key without the key ever leaving the Worker.

People get in one of two ways, and both use the API key slot:

- **An invite code** (`kp_...`) that you mint and hand out. Testers run the Komposit app with it where an API key would go.
- **A signed-in account** (optional). Someone signs in with Google, you grant their email a monthly allowance, and they use it without any code. The web page then uses the session it got at sign-in (`ks_...`) as its key.

```js
new Anthropic({ baseURL: "https://gateway.komposit.werq.dev", apiKey: "kp_..." })  // invite, from the app
new Anthropic({ baseURL: "https://gateway.komposit.werq.dev", apiKey: "ks_...",     // session, from the web page
                dangerouslyAllowBrowser: true })
```

The gateway checks the credential and enforces its limits. It forwards the request to `https://api.anthropic.com/v1/messages` with your key, streams the response straight back, and meters token usage from the response as it passes through. To the SDK it looks exactly like the Anthropic API, including error shapes, so `AuthenticationError`, `RateLimitError` and the rest work as usual.

```
tester's app ───(invite code)──┐
                               ├─▶ gateway ──(your key)──▶ api.anthropic.com
web page ──(sign-in session)───┘      │
                        KV INVITES: invite codes (hashed), their limits
                        KV USAGE:   requests per day, tokens per month
                        D1 DB:      accounts, sessions (hashed), sign-in state
```

Signing in is never required. Invites, the app and the web page all work without it, and the gateway runs without D1 or a Google client; sign-in is then simply off.

## Files

| Path | What it is |
| --- | --- |
| `src/index.js` | The Worker's entry: routes, the proxy, metering, `/v1/me`, `/health`. ES modules, no dependencies. |
| `src/accounts.js` | Sign-in with Google, sessions, account deletion. |
| `src/cors.js` | The allowed origins (sign-in return and CORS) and the CORS headers. |
| `src/util.js` | Small shared helpers. |
| `migrations/` | The D1 schema: `users`, `sessions`, `oauth_states`. |
| `wrangler.toml` | Name, KV and D1 bindings (the official deployment's ids; `setup.sh` writes yours for your own deployment), vars, the custom-domain route. |
| `setup.sh` | One-time setup and deploy: KV, D1, migrations, secrets, deploy, health. |
| `scripts/mint-invite.mjs` | Prints a new invite code and the `wrangler` commands that store or revoke it. |
| `scripts/grant.mjs` | Grants, changes, revokes or lists account allowances, by email. |
| `test/mock-upstream.mjs` | A fake Anthropic API (SSE and JSON) that records what it receives. |
| `test/mock-google.mjs` | A fake Google OAuth server: checks the authorize URL, exchanges codes (PKCE included), crafts id_tokens. |
| `test/gateway.test.mjs` | End-to-end tests against `wrangler dev --local`. |

## Routes

| Route | Credential | Purpose |
| --- | --- | --- |
| `POST /v1/messages` | invite or session | The proxy. Same request and response as the Messages API, streaming included. |
| `GET /v1/me` | invite or session | Who is calling, their limits and usage (shapes below). The app uses it to check a code. |
| `DELETE /v1/me` | session | Deletes the account, all its sessions and its usage counters. `204`. An invite gets `403 permission_error`. |
| `GET /auth/google/start?return=<origin>` | none | Starts a sign-in: `302` to Google. |
| `GET /auth/google/callback` | none (Google sends the browser here) | Finishes it: `302` to `<origin>/#ks=<session>`, or `<origin>/#ks_error=<code>`. |
| `POST /auth/logout` | session | Ends that session. `204`, also when it had already ended. No session in the header: `401`. |
| `GET /health` | none | `{"ok":true,"signIn":true}`; `signIn: false` adds `signInMissing: [...]`. `503 {"ok":false,"missing":[...]}` if the Anthropic key or a KV binding is missing. Sign-in never makes the gateway unhealthy. |

Every other route returns a 404 in the Anthropic error shape.

### Credentials

The credential is read from `x-api-key`, or from `Authorization: Bearer <credential>`. Anthropic SDK 1.x sends API keys the second way. A credential starting `ks_` is a session; anything else is looked up as an invite code. Both get the same proxy, limits and metering.

| Problem | Answer |
| --- | --- |
| Missing, unknown or revoked invite code | `401 authentication_error` "Invalid invite code" |
| Unknown, expired or signed-out session | `401 authentication_error` "This sign-in is no longer valid. Sign in again." |
| Session of an account with no allowance | `403 permission_error` "This account has no Komposit allowance yet." |
| Over a limit | `429 rate_limit_error`, see [How the limits work](#how-the-limits-work) |

### `GET /v1/me`

For an invite code (the shape the app has always read, plus `kind`):

```json
{
  "kind": "invite",
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

For a session:

```json
{
  "kind": "account",
  "name": "Jane Doe",
  "email": "jane@example.com",
  "allowance": 2000000,
  "limits": { "dailyRequests": 300, "monthlyOutputTokens": 2000000, "maxTokens": 64000,
              "models": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] },
  "usage": { "today": { ... }, "thisMonth": { ... } },
  "sessionExpiresAt": "2026-12-10T09:12:44.120Z"
}
```

`email` is `null` when Google didn't report a verified email. `allowance` is `0` until you grant one. Both shapes are sent with `cache-control: no-store`.

### Browsers (CORS)

`/v1/messages`, `/v1/me`, `/auth/logout` and `/health` (the hosted page reads it to decide whether to offer sign-in and invites) answer browsers on the allowed origins: `RETURN_ORIGINS` (default `https://app.komposit.werq.dev`) plus the app's own local page, `http://127.0.0.1:4321`-`4330` and `http://localhost:4321`-`4330`.

- A preflight (`OPTIONS` with `Origin` and `Access-Control-Request-Method`) gets `204` with `Access-Control-Allow-Origin: <origin>`, the route's methods, `Access-Control-Max-Age: 7200`, and `Access-Control-Allow-Headers` echoing `Access-Control-Request-Headers`. The `*` wildcard would not cover `Authorization`, and the browser SDK sends many headers (`anthropic-dangerous-direct-browser-access`, `anthropic-version`, `x-stainless-*`). Echoing them is safe because the gateway builds its upstream headers from scratch.
- Every response to an allowed origin, errors included, carries `Access-Control-Allow-Origin`, `Vary: Origin` and `Access-Control-Expose-Headers: request-id, retry-after, retry-after-ms, x-should-retry`.
- No credentials mode: the session travels in a header, never in a cookie.
- Any other origin gets no CORS headers at all; its preflight is a 404. Calls with no `Origin` (server to server, like the app's local server) work exactly as before.

## Sign-in with Google (optional)

The flow is OAuth 2.0 authorization code with PKCE (S256), `state` and `nonce`, scope `openid email profile`, `prompt=select_account`.

1. The page sends the browser (a top-level navigation, not a fetch) to `/auth/google/start?return=https://app.komposit.werq.dev`. `return` must be exactly an allowed origin: no path, query or user info. Anything else gets a plain error page, never a redirect.
2. The gateway stores the one-time state in D1 (`oauth_states`, only its SHA-256, with the PKCE verifier, the nonce and the return origin; 10 minutes). It also sets the same state in an HttpOnly, `SameSite=Lax` cookie for `/auth/google/` only (`__Secure-ks_state` over https). Then it redirects to Google.
3. Google sends the browser to `/auth/google/callback?code&state`. The gateway deletes the state row as it reads it, so a state works once, and requires the cookie to match. That ties the callback to the browser that started, so nobody can sign you in to their account by sending you a callback link (login CSRF).
4. It exchanges the code at Google's token endpoint with the client secret, the same `redirect_uri` and the PKCE verifier. It reads the `id_token` from that response and checks `iss` (`https://accounts.google.com` or `accounts.google.com`), `aud` (and `azp`), `exp` (2 minutes of clock skew), `nonce` and `sub`. The JWT signature is not verified. OpenID Connect Core 3.1.3.7 allows that for an id_token received directly from the token endpoint over TLS: the TLS connection authenticates Google. That is why `GOOGLE_TOKEN_URL` must be https; plain http is accepted only for `127.0.0.1` and `localhost`, which the tests use.
5. It finds the account by Google's subject id. Otherwise it claims a row you pre-granted by email, but only if Google says the email is verified. Otherwise it creates an account with allowance 0. The access token Google returns is never used or stored.
6. It mints a session, `ks_` plus 52 random base32 characters (260 bits). It stores only its SHA-256, for 30 days, and redirects to `<return>/#ks=<session>`. A fragment is never sent to any server.

Errors go back as `<return>/#ks_error=<code>` once the return origin is known:

| Code | Meaning |
| --- | --- |
| `unavailable` | Sign-in isn't set up on this gateway (see `/health`), or its storage failed |
| `cancelled` | The person clicked Cancel at Google |
| `state` | The callback reached a different browser than the one that started (no cookie, or another one) |
| `expired` | More than 10 minutes between start and callback |
| `google` | Google reported another error, or sent no code |
| `token` | The code exchange failed |
| `id_token` | The id_token failed a check |
| `server` | Saving the account or session failed |

An unknown or already used state has no return origin, so it gets a plain error page.

What the page has to do with the result: read `ks` or `ks_error` from `location.hash` and remove it at once with `history.replaceState`, so it doesn't stay in the address bar or history. Keep the session (for example in `localStorage`) and send it as the API key. Call `GET /v1/me` to show the name, allowance and usage. Treat a `401` as "signed out". Sign out with `POST /auth/logout`, and delete the account with `DELETE /v1/me`. The page's Content-Security-Policy must allow `connect-src https://gateway.komposit.werq.dev`.

### Google Cloud setup

The owner's client already exists. For another deployment:

1. In Google Cloud, set up the OAuth consent screen (Google Auth Platform: Branding and Audience) with the app name, a support email and `werq.dev` as an authorized domain. Use the scopes `openid`, `email` and `profile`. Set the publishing status to In production; while it says Testing, only the test users you list can sign in.
2. Create an OAuth client of type **Web application**. Its authorized redirect URIs are `https://gateway.komposit.werq.dev/auth/google/callback`, plus `http://localhost:8787/auth/google/callback` if you want to try real sign-in with `npm run dev`. It needs no JavaScript origins.
3. Put the client id into `GOOGLE_CLIENT_ID` in `wrangler.toml`. It is public. Store the client secret as a Worker secret: `npx wrangler secret put GOOGLE_CLIENT_SECRET`.

The `redirect_uri` the gateway sends is `<the gateway's own origin>/auth/google/callback`, so sign-in only works on a hostname you registered. On the `workers.dev` URL, Google refuses it.

## Setup (once)

Run everything from `gateway/`. Wrangler 4 needs Node 22 or newer.

1. **Install.** `npm install`. This installs the pinned `wrangler`, plus the Anthropic SDK, which only the tests use.
2. **Log in to Cloudflare.** `npx wrangler login`, or set `CLOUDFLARE_API_TOKEN`. Use the account that owns the `werq.dev` zone.
3. **Pick a plan.** Workers Paid ($5/month) is strongly recommended. Each proxied request costs 2 KV writes (one for the request count, one for the token totals). The Free plan allows 1,000 KV writes a day, which is about 500 requests across all testers, and Komposit's agent loop makes one request per tool call. Past that, KV writes fail. The gateway keeps serving requests, but it stops counting them, so the limits stop working until the next UTC day. The Free plan also caps CPU time at 10 ms per request. A signed-in request also makes one D1 read; sign-ins and grants make a few D1 writes.
4. **Make a dedicated Anthropic API key.** Create it in its own workspace in the Claude Console and give that workspace a monthly spend limit. That limit is the one hard ceiling on what invitees can cost you (see Security).
5. **Run `./setup.sh`.** It is safe to re-run, and it finds what already exists:
   1. It shows the Cloudflare account and asks whether it owns werq.dev.
   2. It finds or creates the KV namespaces `komposit-gateway-INVITES` and `komposit-gateway-USAGE`. It matches those titles exactly, so it never picks up another project's namespace.
   3. It finds or creates the D1 database `komposit-gateway` and applies `migrations/`. The ids go into `wrangler.toml`.
   4. It checks `GOOGLE_CLIENT_ID`. While it is the placeholder, sign-in stays off.
   5. It stores the secrets `ANTHROPIC_API_KEY` and `GOOGLE_CLIENT_SECRET`. Wrangler asks for each one without showing it.
   6. It deploys and checks `/health`, including whether sign-in is on.

   Without a terminal (a script or an agent's shell), pass `--yes`. Nothing is asked then, and the secrets come only from the environment:

   ```sh
   GATEWAY_ANTHROPIC_API_KEY=... GOOGLE_CLIENT_SECRET=... gateway/setup.sh --yes
   gateway/setup.sh --yes --no-deploy     # only KV, D1 and the migrations
   ```

   The script pipes each value to `wrangler secret put` with the shell's built-in `printf`, so it never appears on a command line, in the output or in a file. It reads `GATEWAY_ANTHROPIC_API_KEY` rather than `ANTHROPIC_API_KEY`, so a personal key in your shell is never uploaded by accident. A secret whose variable is unset is left as it is.
6. **Check the model list.** Requests for any model that isn't in `ALLOWED_MODELS` (`wrangler.toml`) get a 400. The default list is `claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5`. Make sure it covers every model the app sends.

The same steps by hand, all without prompts:

```sh
cd gateway
npx wrangler kv namespace create komposit-gateway-INVITES   # put the id into wrangler.toml (INVITES)
npx wrangler kv namespace create komposit-gateway-USAGE     # put the id into wrangler.toml (USAGE)
npx wrangler d1 create komposit-gateway                     # put the database_id into wrangler.toml
npx wrangler d1 migrations apply DB --remote                # asks first at a terminal; goes ahead otherwise
printf '%s' "$GATEWAY_ANTHROPIC_API_KEY" | npx wrangler secret put ANTHROPIC_API_KEY
printf '%s' "$GOOGLE_CLIENT_SECRET" | npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler deploy
curl https://gateway.komposit.werq.dev/health               # {"ok":true,"signIn":true}
```

`secret put` reads the value from stdin when there is no terminal. If the Worker doesn't exist yet, it creates an empty one to hold the secret, and `deploy` replaces it. A new migration in `migrations/` is applied the same way, with `d1 migrations apply DB --remote`, before the deploy that needs it.

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

To try sign-in: open `https://gateway.komposit.werq.dev/auth/google/start?return=https://app.komposit.werq.dev`, pick an account, and copy the `ks_...` from the address you land on. Then `curl https://gateway.komposit.werq.dev/v1/me -H "x-api-key: ks_..."` shows the account with allowance 0, until you grant one.

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

## Accounts

An account's monthly output-token limit is its **allowance**: 0 (no access) until you grant one. Requests per day, `max_tokens` and the models are the gateway defaults (`DEFAULT_DAILY_REQUESTS`, `MAX_TOKENS_CAP`, `ALLOWED_MODELS`).

```sh
node gateway/scripts/grant.mjs jane@example.com 2m        # grant or change: 2000000, 2m, 500k
node gateway/scripts/grant.mjs revoke jane@example.com    # back to 0; the account and its sign-in stay
node gateway/scripts/grant.mjs list                       # every account: email, name, allowance, signed in, live sessions
# or, from gateway/:  npm run grant -- jane@example.com 2m
```

Like `mint-invite.mjs`, it changes nothing by itself. It prints the exact `npx wrangler d1 execute DB --command "..." --remote` command, and a `--local` one for `npm run dev`. Add `--run remote` (or `--run local`) to run it from there instead.

- **Before they sign in.** Granting an email nobody has signed in with yet creates a placeholder row. The first sign-in with that email claims it, but only if Google says the email is verified. Gmail addresses must match exactly, dots included; `list` shows the address each account signed in with.
- **When it applies.** D1 is strongly consistent, so a grant or revoke applies to the very next request. This month's usage so far still counts against a new allowance.
- **Usage.** Usage lives in KV under the account's id: `npx wrangler kv key get --binding USAGE "tok:user:<id>:2026-11" --text --remote`.
- **Deletion.** People delete their own account from the app (Settings, which calls `DELETE /v1/me`). To delete one for them, find its id with `list` and run:

  ```sh
  npx wrangler d1 execute DB --remote --command "DELETE FROM sessions WHERE user_id = 42; DELETE FROM users WHERE id = 42"
  npx wrangler kv key list --binding USAGE --remote --prefix "tok:user:42:"   # then kv key delete each, and the same for "req:user:42:"
  ```

What is stored, and the privacy note for the people who sign in, is in [docs/privacy.md](../docs/privacy.md).

## How the limits work

| Limit | Default (var) | Stored in `USAGE` | Counted |
| --- | --- | --- | --- |
| Requests per UTC day | `DEFAULT_DAILY_REQUESTS` = 300 | `req:<meter>:<YYYY-MM-DD>` | When a request arrives, once it passes validation and before it is forwarded |
| Output tokens per UTC month | `DEFAULT_MONTHLY_OUTPUT_TOKENS` = 2,000,000 for invites; an account's own allowance | `tok:<meter>:<YYYY-MM>` | When the response finishes, from the `usage` Anthropic reports |
| `max_tokens` per request | `MAX_TOKENS_CAP` = 64000 | (none) | Larger values are lowered to the cap before forwarding |
| Models | `ALLOWED_MODELS` | (none) | Anything else is a 400 `invalid_request_error` |

`<meter>` is the invite's hash (64 hex characters), or `user:<id>` for an account. The two can never collide.

- Both limits are checked before a request is forwarded. At the limit, the caller gets a `429 rate_limit_error` whose message names the limit and when it resets ("This invite's ..." or "This account's ..."). The response carries `retry-after` (seconds until the reset) and `x-should-retry: false`. The latter matters: without it, Anthropic SDK 1.x would honour `retry-after` and wait until midnight.
- Token usage is read as the response streams past. For SSE, that is `message_start.message.usage` plus the cumulative `message_delta.usage`. For JSON, it is `usage`. When the API itemises server-side steps (refusal fallbacks, compaction) in `usage.iterations`, those are summed. The totals land in KV inside `ctx.waitUntil`, so they never delay the response. Input, cache-write and cache-read tokens are recorded next to output tokens and shown in `/v1/me`, but only output tokens have a cap.
- If the client disconnects mid-stream (the app's Stop button), the gateway cancels the upstream request, so generation stops at once, and it records the usage seen so far.
- Requests that fail validation (401, 403, 400, 413, 429) don't count. Upstream errors such as 529 overloaded do count as requests, but they have no tokens.
- These are soft caps. KV is eventually consistent and accepts about one write per second per key. Concurrent requests can read the same count, and a request that crosses the token budget still finishes. Expect overshoot of a few requests or one response's worth of tokens, more if one invite is used from several regions at once. Daily keys expire after 8 days, and monthly keys after about 13 months.
- Per-invite `dailyRequests` / `monthlyOutputTokens` override the defaults. `0` blocks the invite. For "unlimited", use a very large number. An account's allowance of 0 gets a 403 instead, which says it has no allowance yet.

The request body is otherwise forwarded byte-for-byte. `fallbacks`, `thinking`, `output_config`, `cache_control`, tools and everything else are untouched. The only time the gateway re-serialises the body is to lower `max_tokens`. Only `anthropic-version` and `anthropic-beta` are copied from the client's headers, and the query string (`?beta=true` from older SDKs) is kept.

## Local development and tests

```sh
npm test
```

This needs no Cloudflare account, no Google account and makes no calls to Anthropic. It takes about 45 seconds:

1. It starts `test/mock-upstream.mjs` and `test/mock-google.mjs` on free ports.
2. It seeds a throwaway local KV under `.wrangler/test-state-*/` with `wrangler kv bulk put --local`. It creates a local D1 with `wrangler d1 migrations apply --local` and adds two ready-made accounts. These are the same tools an operator uses.
3. It runs `wrangler dev --local` (miniflare) with `UPSTREAM_BASE` and the Google endpoints pointed at the mocks, a fake `ANTHROPIC_API_KEY` and a fake Google client. It passes `--local-upstream`, because otherwise wrangler dev gives the Worker the route's hostname as its URL, and sign-in builds its `redirect_uri` from that URL. Then it runs the 30 tests in `test/gateway.test.mjs`.
4. It shuts everything down and deletes the state.

The tests cover streaming pass-through, owner key versus invite, Bearer auth, the `max_tokens` clamp, the model check, both 429s, `/v1/me`, usage recording, client disconnects, the official SDK, and the mint and revoke commands. For sign-in, they cover:

- the authorize URL (PKCE, state, nonce) and refused return origins;
- account creation and the `#ks=` redirect;
- bad, replayed, expired and other-browser states, and a cancelled sign-in;
- a wrong nonce, audience, issuer or expiry;
- an email pre-grant claimed only with a verified email;
- a grant through `grant.mjs`'s printed `--local` command, metered against the allowance, then revoked;
- logout, and expired sessions;
- `DELETE /v1/me`;
- CORS for the app's origins and the browser SDK's headers, and nothing for other origins.

The last two tests check that the logs never contain codes, keys, bodies, sessions, OAuth codes, states, id_tokens, the client secret, emails or names. Set `DEBUG_GATEWAY=1` to see the Worker's output, or `KEEP_TEST_STATE=1` to keep the local KV and D1.

The tests seed KV and D1 with `wrangler ... --local` rather than through a dev-only HTTP route. That way the deployed Worker has no seeding code path that a stray variable could switch on.

To poke at it by hand:

```sh
node test/mock-upstream.mjs 8788      # in one terminal: fake Anthropic, logs what it receives
npx wrangler d1 migrations apply DB --local
npx wrangler dev --local --port 8787 --local-upstream localhost:8787 \
  --var UPSTREAM_BASE:http://127.0.0.1:8788 --var ANTHROPIC_API_KEY:dummy
node scripts/mint-invite.mjs "Me"     # run the printed --local command, then call localhost:8787
```

To use the real API locally instead, put `ANTHROPIC_API_KEY=...` in `gateway/.dev.vars` (git-ignored) and run `npm run dev`. That applies the local migrations and serves `http://localhost:8787`. For real Google sign-in locally, add `GOOGLE_CLIENT_SECRET=...` to `.dev.vars`, and register `http://localhost:8787/auth/google/callback` on the OAuth client. Then open `http://localhost:8787/auth/google/start?return=http://127.0.0.1:4321`, using `localhost`, not `127.0.0.1`, for the gateway, so the state cookie and the redirect URI match.

## Security

- **The key stays in the Worker.** It exists only as a Worker secret. It is sent only to `UPSTREAM_BASE`, is never returned to clients, and is never logged.
- **Client credentials never reach Anthropic.** Upstream headers are built from scratch. The client's `x-api-key` / `Authorization` (the invite code or session), `Origin`, `anthropic-dangerous-direct-browser-access`, `x-stainless-*` and everything else are dropped. Only `anthropic-version` and `anthropic-beta` are copied.
- **Responses are filtered.** Only `content-type`, `request-id`, `retry-after`, `retry-after-ms` and `x-should-retry` come back. The headers that describe your account, `anthropic-organization-id` and `anthropic-ratelimit-*`, are stripped.
- **Credentials are stored only as hashes.** KV holds only the SHA-256 of each invite code, and D1 only the SHA-256 of each session and of each sign-in state. Codes carry 120 random bits and sessions 260, so they can't be guessed. If you're worried about request floods, add a Cloudflare WAF rate-limiting rule for the hostname, including `/auth/*`: every sign-in start writes a D1 row.
- **Sign-in.** It uses the authorization code flow with PKCE (S256), a single-use state bound to the starting browser by an HttpOnly cookie, and a nonce. The `return` origin must be on the allowlist, so there is no open redirect, and the session reaches the page only in a URL fragment. The callback's responses send `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, and the error page sends a CSP of `default-src 'none'` and `X-Frame-Options: DENY`. The id_token's signature is not verified, as allowed for a token taken straight from the token endpoint over TLS (see [Sign-in with Google](#sign-in-with-google-optional)). An email counts only if Google marks it verified, so an unverified address can't claim someone's pre-grant.
- **Sessions.** They last 30 days, are deleted by `POST /auth/logout` and `DELETE /v1/me`, and expired ones are swept at sign-in. A revoke or deletion in D1 applies to the very next request, unlike invites in KV.
- **CORS** is limited to the allowed origins, with no credentials mode. Since credentials travel in headers, a page on another origin can't make a browser send them.
- **Logs are metadata only.** There is one JSON line per request: the invite's name (your label) or the account's number, model, status, token counts and timing. Sign-in events log an account number and a reason code. Request and response bodies, codes, sessions, OAuth codes and tokens, emails, names and keys are never logged, and the test suite checks this. Cloudflare redacts headers such as `x-api-key` and `authorization` in Workers Logs.
- **Revoking an invite takes about a minute**, because of KV edge caching.
- **What the gateway does not police.** Input tokens are recorded but not capped. Paid add-ons that a request can turn on are passed through: fast mode, web search, code execution. So are model names nested inside the body, such as an explicit `fallbacks` list or an advisor tool. The spend limit on the dedicated Console workspace (Setup, step 4) is the backstop for all of this, and for the soft-cap overshoot above.
- **KV failures fail open.** If KV rejects a counter write (for example, the Free plan's daily write limit), the request still goes through and the error is logged as `kv_write_failed`. If the invite lookup itself fails, requests get a 503. If D1 fails, sessions get a 503 and sign-in sends people back with `#ks_error=unavailable` or `server`. Invites keep working.
