# Komposit: architecture

> A design agent that works on your **live** Adobe document. You say what you
> want; it writes and runs its own ExtendScript in the open file, renders the
> result so it can see its work, checks it, and stops. It saves only when you
> ask: every change sits in the app's undo history, so you keep or discard it.

This is the in-repo picture of how Komposit fits together. Read this file first.
Windows specifics are in [windows.md](windows.md).

---

## 1. Shape

```
                          the web (optional)                         this Mac
                 ┌──────────────────────────────┐   ┌─────────────────────────────────────────┐
 browser ───────▶│ app.komposit.werq.dev        │   │ Komposit.app (menu bar)                  │
   │             │   static UI (web/ Worker)    │   │   └─ node  companion/server.mjs  :4321    │
   │             └──────────────────────────────┘   │        ├─ UI served locally too  (ui/)   │
   │  fetch http://127.0.0.1:4321 (token)           │        ├─ engines: Claude Code | API     │
   └───────────────────────────────────────────────▶│        ├─ tools → bridges → platform/    │
                                                    │        └─ chats + settings on disk       │
                                                    └──────────────┬──────────────────────────┘
                                                                   │ AppleScript (Mac) · COM / AfterFX.exe (Windows)
                                                         Illustrator · Photoshop · After Effects

 AI, chosen per Mac:  Claude Code (subscription) · Anthropic key · OpenAI-compatible key ·
                      invite code ──▶ gateway.komposit.werq.dev (gateway/ Worker, owner's key)
```

- **The local half** (the Mac DMG, or the Windows installer) drives the Adobe
  apps and reads design files. Nothing else can: the scripting bridge and the
  files are on that computer. Everything that differs between macOS and Windows
  is in `companion/platform/` (section 8).
- **The web half** is a static page plus an invite gateway. The page holds no
  data; it talks straight to the local half. The gateway holds the owner's
  Anthropic key for invited testers.

---

## 2. The local server: `companion/server.mjs`

A `node:http` server on `127.0.0.1`, first free port in 4321–4330 (it prints
`KOMPOSIT_READY port=N`; the menu-bar app reads that). It serves the UI, the
setup API, the workspace API and agent turns (server-sent events).

### Who may call it: `companion/auth.mjs`

It drives Adobe apps and reads files, so every request passes four locks:

1. **Host check**: `Host` must be `127.0.0.1|localhost:<port>`. Blocks DNS rebinding.
2. **Origin allowlist**: the local UI's origin and the hosted UI
   (`https://app.komposit.werq.dev`, plus `KOMPOSIT_WEB_ORIGINS` / `config.webOrigins`).
   Browsers can't forge `Origin`.
3. **Per-install token**: every `/api/*` call carries `Authorization: Bearer <t>`.
   The local page gets it inlined in its HTML (`<meta name="komposit-token">`,
   which other origins can't read). The hosted page gets it once from
   `GET /connect?return=<origin>`, which redirects to `<origin>/#k=<token>&p=<port>`.
   Fragments are never sent to a server. Public routes: `/`, static files, `/api/hello`, `/connect`.
4. **JSON-only writes**: POST/PUT/DELETE must be `application/json`, so a form
   or `text/plain` beacon can't trigger anything.

Plus CORS for allowed origins and `Access-Control-Allow-Private-Network` on
preflights. The HTML shell is `no-store`, `X-Frame-Options: DENY`,
`frame-ancestors 'none'`. Verified with curl: wrong host 421, foreign origin 403,
missing token 401, form POST 415, path traversal 404.

### Routes

| Route | What |
|---|---|
| `GET /` | the UI, token inlined |
| `GET /api/hello` | `{komposit, version, port}` (public; used to find the app) |
| `GET /connect[?return=origin][&local=1]` | hand the token to the hosted UI, or open the local one |
| `GET /api/status` | version, AI choice (hints only), onboarded |
| `GET /api/setup` · `POST /api/setup/{ai,ai/forget,automation,launch,files,settings,done}` | onboarding checks and actions |
| `GET /api/workspace` · `/api/files?dir=` · `/api/thumb?path=` | running apps, recent files, folder tree, previews |
| `POST /api/new` · `/api/open` | new document · open a file in its app |
| `GET /api/chats` · `GET|DELETE /api/chats/:id` · `POST /api/chats/:id/rename` · `GET /api/chats/:id/img/:name` | chat history and its images |
| `POST /api/turn` | run one turn; SSE stream |
| `POST /api/stop` | stop a chat's running turn |

### Settings: `companion/config.mjs`

`~/Library/Application Support/Komposit/config.json` (mode 0600; Windows:
`%APPDATA%\Komposit\config.json`): the token,
the chosen AI (`claude-code | anthropic | openai | invite` with key/code), and
onboarding state. Keys go only to the service the tester picked; the UI sees
hints (`sk-ant-…3f9a`). In a repo checkout, `.env` is the fallback when no AI is
chosen (`MODEL_PROVIDER=cli` means Claude Code).

### Onboarding: `companion/setup.mjs`

- **Adobe apps**: installed (Spotlight by bundle id), running (`pgrep`), and
  **Automation permission** read silently by `komposit-helper`
  (`AEDeterminePermissionToAutomateTarget`). "Allow" asks macOS to show its
  consent dialog for that app. Windows has no such permission: "Test
  connection" runs a read-only script.
- **Design folders**: Desktop, Documents, Downloads. On a Mac these are only
  read after the tester clicks Allow, because the first read shows a macOS
  prompt; Windows doesn't ask (and its folders can be redirected by OneDrive).
- **Claude Code**: found through the login-shell PATH and the usual install
  folders (`shellenv.mjs`); `claude auth status` tells signed-in and plan.
- **AI choice**: validated before it's saved. Anthropic key via the SDK's
  models list; OpenRouter via `/api/v1/key`; other services via `/models`;
  invite codes via the gateway's `/v1/me`.

### Chats: `companion/chats.mjs`

`<data>/chats/<id>/chat.json` holds what the UI shows: turns with plain-language
steps, notes, the final message, timings, errors. `api.json` holds the API
engine's message history (append-only). `img/` holds renders and reference
images, served by URL. Chats survive reloads and restarts. A turn still running
after a reload is polled until it ends.

---

## 3. A turn

```
UI ── POST /api/turn {chatId?, app, effort, text, images} ─▶ server
                                                         ├─ claude-code → engines/cli.mjs
                                                         └─ anthropic | invite | openai → harness/loop.mjs
UI ◀─ SSE: start · note · text · step · step_done · final · error · done ──┘
```

The server normalizes both engines' events (`labels.mjs` turns `inspect` into
"Looking at the document" and so on), records them on the turn, saves renders as
files, and streams them. The UI shows each turn as **activity** (live steps with
a timer, collapsed when done), **result** (the latest render) and **message**
(markdown). Time is shown, never cost.

Effort picker: `low | medium | high` = Fast / Balanced / Thorough.
- Claude Code: Sonnet at low/medium effort; Opus at high.
- API: Claude Opus 5.5 with `output_config.effort` low, medium or high.

While a turn works in an app, preview rendering of that app's documents is
paused (`preview.markBusy`), so the agent's edit can't land on the wrong document.

### Claude Code engine: `engines/cli.mjs`

It runs the tester's own `claude -p` (their subscription), with Komposit's MCP
doc server as its only tools (`--strict-mcp-config`, `--allowedTools`). The doc
server runs on the same Node binary as the server (`process.execPath`), so it
works inside the app bundle.

- **Billing:** API-key variables are stripped from the child, so it never bills a metered key.
- **Memory:** sessions live in `<data>/claude-code` and resume per chat and app (`--resume`).
- **Stop:** kills the whole process group.

### API engine: `harness/loop.mjs` + `providers/`

- **`anthropic.mjs`** (official SDK `@anthropic-ai/sdk` 1.3.0, API version
  2026-10-21) calls `claude-opus-5-5` with:
  - adaptive thinking with `display: "updates"`, so the model's short notes between tool calls arrive as text and the UI shows them as progress;
  - `output_config.effort` from the picker;
  - `fallbacks: "default"`: if a safety classifier declines, the API retries on Anthropic's recommended fallback model;
  - prompt caching: a breakpoint on the system prompt plus top-level automatic caching;
  - `eager_input_streaming` on tools, with every tool input validated before it runs;
  - refusal handling.
- **The history is append-only:**
  - earlier messages, thinking blocks included, go back exactly as received;
  - the system prompt and the tool list never change during a chat (one prompt covers all three apps, and each user message says `[App: Photoshop]`).

  Opus 5.5 rejects edited history on newer accounts, and the same rule keeps the cache hitting. Old screenshots are not pruned: cache reads make them cheap.
- **`invite`** is the same provider pointed at the gateway, with the invite code in place of a key.
- **`openai.mjs`** speaks Chat Completions (OpenRouter, OpenAI, others) and round-trips OpenRouter `reasoning_details`. Its safety net: if a request carrying them gets a 400, it retries once with them stripped.

### The tools and the bridges

`harness/tools.mjs`: `inspect` (state map with refs + screenshot), `edit`
(ES3 ExtendScript; read values by `return`; never saves), `undo`, `render`,
`export`, `save`, `preflight`. The API engine always offers all seven (a stable
prefix; an unsupported call returns a plain error); the MCP server offers what
each app's `capabilities` lists. File-writing tools return a structured result:
`ok`, `path`, a note on what the file is good for, `warnings`, and whether the
open document was left unchanged.

- **export** writes a new file (`bridges/files.mjs`: inside the home folder,
  default `~/Komposit Exports`, never overwrites; a taken name gets " 2").
  Illustrator png/jpg/svg/pdf, Photoshop png/jpg, After Effects one png frame.
- **Illustrator PDF** needs `saveAs`, which repoints the open document, so it is
  made from a throwaway copy: a saved file is copied on disk and opened (after
  waiting for Illustrator's background save to settle); a document with unsaved
  changes is rebuilt in a new document (artboards, layers, art duplicated).
  Never rebuild a saved document: duplicating its art marks it changed.
  Defaults: [PDF/X-4:2008], 3 mm bleed, crop marks, all artboards.
- **save**: `overwrite` is Cmd+S; `copy` writes a new .ai/.psd (Illustrator via
  the same copy path, Photoshop via `saveAs(asCopy)`); After Effects overwrite only.
- **preflight** (Illustrator, read-only): colour mode, sizes, fonts, links, art
  off or across edges, spot colours, hidden/non-printing layers.

- **Selection** (`harness/context.mjs`, each bridge's `selection()`): read live
  when a message is sent (about 0.4 s, only if the app is running) and put in
  front of the message for the model, with refs; the chat shows one quiet step
  line ("Selected: Circle"). Illustrator: items with refs into groups and
  clipping masks, text ranges, partly selected paths, artboards. Photoshop:
  several selected layers (ActionManager), kinds, masks, marquee. After Effects:
  selected layers, properties and keyframes, playhead, work area. `inspect`
  appends it too.
- **Dialog notice** (`dialogwatch.mjs`): while a step runs, the server lists the
  app's windows (Mac: CoreGraphics via JXA, no permission; Windows: the app's
  top-level windows); a new dialog-sized window that stays up across two looks
  puts a quiet hint on that step.
- **After Effects motion:** `render` takes `frames` (a strip across the work
  area for the model) and `video` (a half-size MP4 preview through the render
  queue, played in the chat's Result); `export` mp4 renders full size. The
  person's queued render items are paused and restored. All After Effects
  results come back through a file, so AE's "Allow Scripts to Write Files and
  Access Network" must be on; Settings detects it when it's off.

Behaviour rules for both engines live in `harness/behavior.mjs`: act rather than
ask (edits are undoable), don't refuse flatly, only offer what the tools do, say
what was and wasn't done. Live checks: `npm run test:live` (needs Illustrator open;
makes and closes its own document, checks the person's documents are untouched).

`bridges/extendscript.mjs` wraps every script in a `{ok, error, logs, data}`
envelope (with its own ES3 JSON encoder) and hands it to the platform layer,
asynchronously (the server stays responsive during long edits), with unique
scratch files per call (the MCP server and the main server can run scripts at
the same time). Illustrator and Photoshop return the script's value; After
Effects writes a result file. On a Mac that's AppleScript `do javascript` /
`DoScript` (`platform/mac.mjs`, with `AUTOMATION_DENIED` when macOS blocks
control); on Windows, COM `DoJavaScript` and `AfterFX.exe -r`
(`platform/win.mjs`). Premiere is out (no AppleScript or COM path).

`harness/guidance.mjs` holds known-good ExtendScript recipes per app; they cut
the edit error rate (one test went from about 100 s with retries to 26 s, first
try).

---

## 4. The UI: `ui/` (index.html, app.css, app.js)

The same files run in two places:

- **Local**: served by the app at `http://127.0.0.1:<port>/`; the token is in the page.
- **Hosted**: served by `web/` from `https://app.komposit.werq.dev`. Boot steps:
  1. Take the token from the URL fragment (or localStorage).
  2. Find the app on 4321–4330.
  3. Gate screens:
     - Chrome's local-network permission: "click Allow".
     - Safari: "Open Komposit", which hands off to the local page.
     - Blocked: how to re-allow, or use the local page.
     - App not running: auto-retry every 3 s.
     - Not paired: Connect through `/connect`.

After connecting:
- **Onboarding** (3 steps): pick the AI, connect the Adobe apps (permissions), try a first edit.
- **Workspace:** composer (app picker, effort, attach, paste or drop reference images; Enter sends), recent files with real renders, folder tree, chats, Settings.

Images from the app need the token, so they load through `fetch` as blob URLs.
Line icons only, no emoji.

### Browser to local app: what works

- **Chrome 157**, public https page to `http://127.0.0.1`:
  - It's blocked until the person allows Chrome's **Local Network Access** permission (`loopback-network`).
  - After that, everything works: authed GET, JSON POST with preflight, streamed responses, images.
  - It is not mixed-content blocking.
- **Safari 18.6 (WebKit)**, public https page to `http://127.0.0.1` or `localhost`:
  - Every request is refused before it leaves the browser (mixed content), and there's no permission to grant.
  - The same UI served by the app itself works fully in WebKit.
- **Decision:** no websocket relay.
  - Chromium browsers (and Firefox) use the hosted page directly.
  - Safari, or anyone who blocks the permission, is sent to the app's own page.
  - A relay would route every edit and render through a cloud service and make the app accept commands that arrive over the internet. That's more latency, more to break, and a bigger attack surface, all for a page Safari users can already get locally.

---

## 5. The Mac app: `packaging/`

`packaging/build-mac.sh` builds `dist/Komposit-<version>.dmg` (about 56 MB, universal):

```
Komposit.app/Contents/
  MacOS/Komposit          Swift menu-bar app (packaging/macos/Komposit.swift)
  MacOS/komposit-helper   Automation-permission check (helper.swift)
  MacOS/node              universal Node 24, keeps its Node.js Foundation signature
  Resources/app/          companion/, ui/, package.json, node_modules (no types/maps)
  Resources/AppIcon.icns  made by make-icon.swift
  Info.plist              LSUIElement, usage strings for Automation + Desktop/Documents/Downloads
```

The menu-bar app:
- **Starts and supervises the server.** It restarts the server after a crash and gives up after 5 crashes in a minute. If a Komposit server is already running, it uses that one.
- **Opens the UI.** It opens the hosted page via `/connect` when the build has `KompositWebURL` and the default browser is Chromium or Firefox; otherwise it opens the local page.
- **Menu:** Open, Restart, Show Log, Show Data Folder, Open at Login, Quit.

macOS attributes the server's permission prompts to Komposit, because the server is the app's child. Quitting, or a SIGTERM, stops running turns; if the app is force-quit, the server notices it was orphaned and exits.

**Signing:** ad-hoc (no Apple Developer account). Gatekeeper rejects it until the tester clicks
*Open Anyway* in System Settings > Privacy & Security, once. Logs go to
`~/Library/Logs/Komposit/server.log`.

**Release:** `packaging/release-mac.sh` (tests, build, `verify-dmg.sh`, then
`dist/Komposit-mac.dmg`); `packaging/publish-release.sh` puts it on the
GitHub Releases page. See [releasing.md](releasing.md).

### The Windows app: `packaging/windows/` (early build)

`node packaging/windows/build.mjs` (and CI, `.github/workflows/windows.yml`)
builds a per-user Inno Setup installer, `Komposit-Setup-<v>.exe`:

```
%LOCALAPPDATA%\Programs\Komposit\
  Komposit.exe       tray app (tray/KompositTray.cs, WinForms, .NET Framework)
  komposit-win.exe   native helper (helper/KompositWin.cs): COM, windows, processes, folders, thumbnails
  node\node.exe      bundled Node 24 x64
  app\               companion/, ui/, node_modules
```

The tray app does what the menu-bar app does (start or attach to the server,
restart it, Open, Restart, Show Log, Show Data Folder, Open at Login, Quit) and
keeps the server in a job object so it never outlives the app. Unsigned:
SmartScreen asks once (More info > Run anyway). The mapping of every macOS
piece to Windows, what's verified and what isn't: [windows.md](windows.md);
the first real-PC test: [windows-testing.md](windows-testing.md).

---

## 6. The web: `web/` and `gateway/` (Cloudflare Workers)

- **`web/`** serves `ui/` (built into `web/public` by `web/build.mjs`, which swaps
  the token slot for the download link). Its CSP allows connections only to the
  site itself and `127.0.0.1` / `localhost`. Deploy: `cd web && npm run deploy`.
- **`gateway/`** is an Anthropic-compatible `/v1/messages` proxy.
  - **Auth:** the API key (`x-api-key` or bearer) is an invite code (`kp_…`) or
    the session of a signed-in account (`ks_…`). Both are stored only as SHA-256
    hashes: invites in KV, sessions in D1.
  - **Sign-in (optional; nothing needs it):** Google OAuth, authorization code
    + PKCE + state + nonce, at `/auth/google/start?return=<origin>` and
    `/auth/google/callback`. The session goes back to the page in a URL fragment
    (`#ks=`). Accounts and sessions are in D1 (`migrations/`). `POST /auth/logout`
    ends a session; `DELETE /v1/me` deletes the account, its sessions and its
    usage. What is stored: [privacy.md](privacy.md).
  - **Limits:** per invite, a daily request limit and a monthly output-token
    limit. Per account, the same daily limit and its own monthly allowance (0
    until the owner grants one, which gets a 403).
  - **Browsers:** CORS on `/v1/messages`, `/v1/me` and `/auth/logout`, only for
    `https://app.komposit.werq.dev` (`RETURN_ORIGINS`) and the local page on
    ports 4321–4330. Calls with no Origin (the local server) are unaffected.
  - **Allowed models:** opus/sonnet/haiku 5.5, with `max_tokens` clamped.
  - **The owner key:** stored as a Worker secret, never in the DMG or the browser.
  - **Usage:** metered from the stream; a hang-up cancels the upstream request.
  - **Invites and allowances:** `scripts/mint-invite.mjs` makes invites;
    `scripts/grant.mjs` grants, revokes and lists account allowances by email.
  - **Setup:** `gateway/setup.sh` (KV, D1 and migrations, secrets, deploy;
    `--yes` runs it without a terminal).
  - **Tests:** `cd gateway && npm test`, against a mock Anthropic and a mock
    Google. See `gateway/README.md`.

---

## 7. Tests

| Command | Covers |
|---|---|
| `npm test` | API engine: request shape (Opus 5.5, betas, fallbacks, effort, caching, eager tools), parsing, append-only history across turns and app switches, refusals, invalid tool input; tools, selection, attachments; incident log; the Windows platform layer (`win.test.mjs`); chat titles; OpenAI-compatible provider |
| `npm run test:live [-- app]` | the above plus live checks: Illustrator export/save/preflight/selection, Photoshop inspect, After Effects selection/frames/preview/MP4 |
| `cd gateway && npm test` | the gateway against a mock Anthropic and a mock Google: invites, sign-in, accounts, CORS |
| `npm run check` | syntax of every module, the UI and the build scripts |
| `packaging/verify-dmg.sh` | a built DMG matches the checkout, universal, signed, the right hosted URL |
| `node packaging/windows/smoke.mjs` (CI) | the Windows build on a PC without Adobe: helper, platform layer, server and its locks, tray self-test, install/uninstall |
| `node packaging/windows/fake-adobe.mjs` (CI) | the Windows transport against stand-in Adobe apps: COM DoJavaScript through the wrapper, errors, timeouts, Stop; the AfterFX.exe handoff; real modal dialogs and the dialog notice |

End-to-end checks done by hand before a release:
- **Security locks:** checked with curl.
- **Claude Code engine:** real turns in Photoshop (10 s; a follow-up resumed in 4 s).
- **API engine:** run through the server against a streaming mock and the real Photoshop bridge.
- **Hosted flow (Chrome):** pairing, onboarding, workspace, under the production CSP.
- **Local UI:** checked in WebKit.
- **DMG:** installed from the DMG as a fresh user (own server, helper, Claude Code found, real turn).

---

## 8. File map

```
companion/
  platform/         index.mjs (picks one) · mac.mjs (AppleScript, JXA, pgrep, mdfind, open, qlmanage, helper)
                    · win.mjs (COM, AfterFX.exe, tasklist, registry, komposit-win.exe)
  scratch.mjs       the scratch folder shared by the bridges and the platform layer
  server.mjs        HTTP + SSE, routes, turn recording, port range, shutdown
  auth.mjs          host / origin / token / JSON locks, CORS + PNA
  config.mjs        settings + token on disk; effective AI; public hints
  setup.mjs         onboarding checks and actions
  shellenv.mjs      login-shell PATH, find `claude`, `claude auth status`
  chats.mjs         chat store (chat.json, api.json, img/)
  titles.mjs        AI-written chat titles
  labels.mjs        plain-language step labels
  incidents.mjs     the incident log and `npm run incidents`
  dialogwatch.mjs   notices when an app shows a modal dialog mid-step
  desktop.mjs       running apps, recent files, folder tree, thumbnails (async)
  preview.mjs       render open docs for cards; busy guard
  env.mjs           .env loader (checkouts only)
  engines/          index.mjs (router, effort map) · cli.mjs (Claude Code)
  harness/          loop.mjs · tools.mjs · system.mjs · behavior.mjs · guidance.mjs · context.mjs (live selection)
                    · attachments.mjs
  providers/        anthropic.mjs (SDK) · openai.mjs · index.mjs
  mcp/doc-server.mjs  Komposit tools over MCP (stdio)
  bridges/          extendscript.mjs (envelope, transport via platform/) · illustrator · photoshop · aftereffects
                    · files.mjs (export paths)
  test/             api-engine · tools · incidents · win · titles · openai-provider (unit)
                    · illustrator.live · aftereffects.live
ui/                 index.html · app.css · app.js · favicon.svg
packaging/          build-mac.sh · release-mac.sh · verify-dmg.sh · publish-release.sh
                    macos/{Komposit.swift, helper.swift, make-icon.swift, Info.plist}
                    windows/{build.mjs, smoke.mjs, komposit.iss, make-icons.swift, helper/, tray/, icons/}
scripts/            check.mjs · test-live.mjs (cross-platform npm scripts)
.github/workflows/  test.yml (unit tests on every push and pull request)
                    · windows.yml (tests, build, smoke tests, installer artifact)
web/                Cloudflare Worker for the hosted UI
gateway/            Cloudflare Worker: invite gateway, optional Google sign-in (D1)
brand/              logo files from the spec (04.C solid tile, wordmark, lockup) · README
docs/               architecture.md (this) · getting-started.md · windows.md · windows-testing.md
                    · releasing.md · release-notes.md · privacy.md (what sign-in stores)
```

---

## 9. Status and roadmap

**Works today:** the Mac app; the local server and UI; the Claude Code,
Anthropic, OpenAI-compatible and invite engines; onboarding; chat history; the
hosted UI and the invite gateway. **Windows** is an early build: tested
automatically on a PC without Adobe apps, not yet on a real PC with Adobe apps
([windows-testing.md](windows-testing.md)).

**Next:**
- Signed and notarized builds.
- A relay so Safari can use the hosted page.
- Grounded edits from a region you point at.
- Premiere Pro through a CEP/UXP panel.

## Incident log

Every failure inside a design app is appended to
`~/Library/Application Support/Komposit/incidents.jsonl`
(`companion/incidents.mjs`, hooked into `bridges/extendscript.mjs`): app timeouts,
crashes (the app process is gone after the call), osascript errors, script
errors thrown inside the app, and After Effects refusals (dialog up, still
starting). Each row has the app, kind, message and the script that was running.

`npm run incidents` groups them by app, kind and message, with the latest
script for each. Nothing from the log is fed back to the model automatically:
a lesson the model writes itself can be wrong and would then repeat. Read the
log, confirm the pattern, and put the fix in `harness/guidance.mjs`.
