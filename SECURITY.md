# Security

Komposit runs a local server that can drive your Adobe apps and read files in
your home folder, so its security matters. Thank you for looking.

## Reporting a vulnerability

Please report privately through GitHub:
**[Security → Report a vulnerability](https://github.com/werqaferaw/komposit/security/advisories/new)**.
Don't open a public issue for it. You'll get a reply within a few days.

## How the local server is locked

The server listens on `127.0.0.1` only (ports 4321–4330) and accepts a request
only when all four of these hold (see `companion/auth.mjs`):

1. **Host check.** The `Host` header must be `127.0.0.1` or `localhost` on its
   port, which defeats DNS rebinding.
2. **Origin allowlist.** Only the local UI and the hosted UI
   (`https://app.komposit.werq.dev`, plus origins you add) may call it.
3. **Per-install token.** Every API call carries a random bearer token. The
   local UI gets it inlined in its page; the hosted UI gets it once through a
   URL fragment, which is never sent to a server.
4. **JSON-only writes.** State-changing requests must be `application/json`, so
   a plain form or beacon from another site can't trigger anything.

The same four locks guard everything the hosted page uses to run a request
itself: `POST /api/tool` (one tool call in an Adobe app) and
`POST /api/turn/start` / `/api/turn/record` (keeping the chat).

## What you are trusting

- **The AI writes and runs scripts in your Adobe apps.** ExtendScript can read
  and write files your user account can reach. Komposit shows every step and
  keeps edits undoable, but a model can be wrong, and text in an attached file
  or an open document can try to steer it (prompt injection). Use it on work you
  can afford to undo, and don't attach files you don't trust.
- **The hosted UI.** The official builds trust `https://app.komposit.werq.dev`
  as an origin, so that page can use the local server once you open it from
  the app's menu. It can run the agent itself and call `POST /api/tool`, which
  runs scripts in your Adobe apps, and ExtendScript can read and write files and
  run commands. So the page is locked down: scripts only from its own origin
  (no third-party scripts, no inline script), connections only to the app on
  your computer and the AI services listed in `web/worker.js`, never framed,
  HTTPS only. If you run your own build and don't want to trust it, remove it
  from `DEFAULT_WEB_ORIGINS` in `companion/auth.mjs`; the app's own local page
  at `http://127.0.0.1:4321` needs no outside origin and runs every request in
  the app.
- **API keys you enter on the hosted page** stay in that browser (its local
  storage for `app.komposit.werq.dev`) and are sent only to the AI service you
  chose (Anthropic, Google, OpenRouter, OpenAI) or Komposit's gateway (invites).
  The page then calls that service straight from the browser and runs the
  agent loop in the tab. Anything that can run code in that page (a malicious
  browser extension, a script injection) could read them, so prefer a key with
  a spend limit, and use Settings > Forget keys in this browser on a shared
  computer. Keys you enter on the app's own local page stay in the app's
  settings file, as below. Subscriptions (Claude Code, Codex) always run in the
  app on your computer.
- **The AI provider you choose** receives your messages, the document state and
  screenshots of your work.

API keys you enter in the app (the local page, or a custom service address)
stay on your computer, in Komposit's settings file (mode 0600 on macOS). The
invite gateway (`gateway/`) holds the owner's Anthropic key server-side; invite
codes and sign-in sessions are stored only as SHA-256 hashes.

Signing in with Google is optional. It uses the OAuth authorization code flow
with PKCE, a single-use state tied to the browser that started it, and a nonce.
It stores only Google's id for the account, a verified email, the name and the
allowance, and you can delete the account yourself
([docs/privacy.md](docs/privacy.md)). The gateway answers browser calls (CORS)
only from the hosted UI and the app's local page; server-to-server calls carry
no Origin and are unaffected. The hosted page keeps the sign-in session in that
browser, like a key.

## In scope

The local server and its locks (including the bridge API the hosted page
uses), the MCP tool server, the hosted UI and its agent loop (`web/`), the
gateway (`gateway/`) and its sign-in, and the Mac and Windows apps.
