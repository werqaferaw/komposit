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

## What you are trusting

- **The AI writes and runs scripts in your Adobe apps.** ExtendScript can read
  and write files your user account can reach. Komposit shows every step and
  keeps edits undoable, but a model can be wrong, and text in an attached file
  or an open document can try to steer it (prompt injection). Use it on work you
  can afford to undo, and don't attach files you don't trust.
- **The hosted UI.** The official builds trust `https://app.komposit.werq.dev`
  as an origin, so that page can use the local server once you open it from
  the app's menu. If you run your own build and don't want that, remove it from
  `DEFAULT_WEB_ORIGINS` in `companion/auth.mjs`; the app's own local page at
  `http://127.0.0.1:4321` needs no outside origin.
- **The AI provider you choose** receives your messages, the document state and
  screenshots of your work.

API keys you enter stay on your computer, in Komposit's settings file
(mode 0600 on macOS). The invite gateway (`gateway/`) holds the owner's
Anthropic key server-side; invite codes are stored only as SHA-256 hashes.

## In scope

The local server and its locks, the MCP tool server, the hosted UI (`web/`),
the invite gateway (`gateway/`), and the Mac and Windows apps.
