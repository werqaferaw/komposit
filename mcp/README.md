# komposit-mcp

A standalone MCP server that lets an AI app work inside your own creative apps: **Illustrator, Photoshop, After Effects and Premiere Pro**, in the documents you have open. It works with Claude Desktop, Claude Code, Codex, OpenCode and any other app that speaks MCP over stdio.

It uses Komposit's open connectors (`connectors/`) and toolkit (`toolkit/`). It's the same set of tools the Komposit app gives its own chats, without the app.

## What you need

- macOS or Windows, with Node.js 22 or later. Windows also needs the small helper program `komposit-win.exe`, which isn't in this repository yet (see `KOMPOSIT_WIN_HELPER` below), and has had far less testing with the real apps than macOS.
- Illustrator, Photoshop, After Effects or Premiere Pro, open. The server never opens an app by itself.
- After Effects: turn on *Allow Scripts to Write Files and Access Network* (Settings > Scripting & Expressions on a Mac, Edit > Preferences > Scripting & Expressions on Windows).
- Premiere Pro: Komposit's small panel inside it (`connectors/premiere/panel/`), which takes the scripts, since Premiere has no outside scripting door. The Komposit app installs it when you press Install for Premiere Pro; standalone, `installPremierePanel()` in `connectors/premiere/install.ts` copies it into your CEP extensions folder and allows unsigned panels (CEP's PlayerDebugMode); Premiere loads it at its next start. `apps` says when it's missing or not loaded.
- macOS: the first time the AI works in an app, macOS asks whether your AI app (Claude, Terminal...) may control it. Say OK. The server never shows this prompt itself. If you said no, turn it on in System Settings > Privacy & Security > Automation.

## Build

```sh
node mcp/build.mjs              # writes out/mcp/komposit-mcp.mjs (one file, Node 22+)
```

From a checkout with Node 24 you can also run the source directly: `node mcp/server.ts`.

In the snippets below, replace `/path/to/komposit-mcp.mjs` with the full path to the built file. If your AI app can't find `node`, use the full path to it (`which node` on a Mac, `where node` on Windows).

## Set it up

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "komposit": {
      "command": "node",
      "args": ["/path/to/komposit-mcp.mjs"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add komposit -- node /path/to/komposit-mcp.mjs
# for every project:  claude mcp add --scope user komposit -- node /path/to/komposit-mcp.mjs
```

For the app recipes as skills, copy the folders in `skills/` into `~/.claude/skills/`.

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.komposit]
command = "node"
args = ["/path/to/komposit-mcp.mjs"]
# Renders and exports can take a while (an After Effects video can take minutes):
tool_timeout_sec = 600
```

### OpenCode

In `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "komposit": {
      "type": "local",
      "command": ["node", "/path/to/komposit-mcp.mjs"],
      "enabled": true
    }
  }
}
```

### Any other MCP app

Add a **stdio** server that runs `node /path/to/komposit-mcp.mjs`. It speaks newline-delimited JSON-RPC 2.0 with MCP revisions 2024-11-05 through 2025-11-25: `initialize` (with server instructions), `notifications/initialized`, `tools/list`, `tools/call`, `ping` and `notifications/cancelled`. It offers no resources or prompts.

## Tools

| Tool | What it does |
|---|---|
| `apps` | Which apps are installed, open and ready, with each app's scripting language and formats. Never opens an app. |
| `documents` | The documents open in an app (or in every open app): name, path, which one is active. |
| `inspect` | A map of the document (layers, items with refs for code, bounds, colors, fonts), the selection, and a picture. |
| `edit` | Runs code in the app's own language (ExtendScript) against the document. Not saved. |
| `render` | A picture of the result (After Effects and Premiere Pro: several frames, or a short preview video; Premiere Pro also watches a stretch as contact sheets). |
| `listen` | Hears sound on this computer: Premiere Pro's sequence or After Effects' comp (each track's levels, speech stretches and pauses, who talks when, a song's tempo, every beat, bars, sections and strongest hits; Premiere Pro's transcripts when the project has them), or one media file with `path` (no app needed). Text plus a picture of the sound; the next `edit` gets it as `K.heard`. |
| `export` | Writes a new file (png, jpg, svg, pdf, mp4, depending on the app). Never overwrites. |
| `save` | Saves, only when you ask: the file itself, a copy, or as a new file. |
| `undo` | Undoes the last step. |
| `preflight` | Illustrator: a print check (colour mode, sizes, fonts, links, bleed). |
| `place` | Brings a file into a document (another app's export, an image). |
| `open` | Opens a file in Illustrator or Photoshop, or a project in Premiere Pro. |
| `new_document` | A new document (After Effects: a new composition). |
| `guide` | The app's tested recipes, by topic. |

Every app tool takes `app` (`illustrator`, `photoshop`, `aftereffects`, `premiere`) and, where it makes sense, `doc` (`{ "name", "path" }` from `documents`) to act on a document other than the one in front. In Premiere Pro, a call that changes a project must pass `doc`, and runs only while that project is the active one.

## Safety rules (in code, not just in the prompt)

- **One call at a time per app.** Calls to the same app wait their turn; different apps work side by side.
- **Nothing is saved unless the `save` tool is called.** Edits stay in the app's undo history.
- **Exports never overwrite.** An existing name gets " 2", " 3"... Exports go to `~/Komposit Exports`, or an `outputDir` inside your home folder.
- **Scripts that reach outside the document are refused** with a plain explanation: deleting, renaming, running, writing or copying files, making folders, saving or exporting to a path, render-queue renders, menu commands that save, export, revert, close or quit, shell commands (`system.callSystem`, Photoshop's `app.system`), quitting the app, closing a document without saving, sending code to another app or running other scripts or recorded actions (`BridgeTalk`, `doScript`, `doAction`, `$.evalFile`, `#include`), code built while it runs (`eval`, `new Function`), network sockets, and saving from a script (including closing with a save option). Files inside `Folder.temp` are allowed. The check reads the code before it's sent. It's a seatbelt, not a sandbox: code built to hide what it does can get past a scan.
- **Apps are never opened for you.** A call to an app that isn't open says so.
- **Premiere Pro: only the project a change names, only while it's the active one.** Premiere's scripts reach whichever project is active, so `edit`, `undo`, `save`, `place` and a preview video need `doc`, and are refused (nothing sent) without it or when that project isn't the active one. An edit can't save, open, close or switch projects, or reach into the other open projects.
- Pictures come back as MCP image content, so the AI sees them.
- **Listening stays on this computer.** Sound is decoded by the system's own decoders (Core Audio and AVFoundation on a Mac, Media Foundation on Windows; WAV and AIFF are read directly) or by ffmpeg when you have it, measured with plain signal maths, and never sent anywhere. Set `KOMPOSIT_FFMPEG` to use a particular ffmpeg.

## Settings (environment variables)

| Variable | Effect |
|---|---|
| `KOMPOSIT_ALLOW_RISKY_SCRIPTS=1` | Run scripts the check would refuse. Only if you trust what your AI is doing. |
| `KOMPOSIT_EXPORT_DIR` | Where exports go by default (must be inside your home folder). Default: `~/Komposit Exports`. |
| `KOMPOSIT_HELPER` | macOS: path to `komposit-helper` (see `helper/mac/`), so `apps` can read the Automation permission without asking. |
| `KOMPOSIT_WIN_HELPER` | Windows: path to a built `komposit-win.exe`, the helper the connectors use for their system calls on Windows. |
| `AE_APP` | macOS: an unusual After Effects app name. |
| `KOMPOSIT_FFMPEG` | Path to an ffmpeg for listening to formats the system can't decode (optional; `ffmpeg` on the PATH is used when present). |

Claude Desktop and Claude Code take them as `"env": { ... }` / `-e NAME=value`; Codex as `env = { NAME = "value" }`; OpenCode as `"environment": { ... }`.

## Tests

```sh
node --test mcp/server.test.ts mcp/build.test.ts
```

The server tests start `node mcp/server.ts` and speak MCP to it over stdio. They replace the connectors with stand-ins (`mcp/testing/fake-connectors.ts`, loaded through `KOMPOSIT_MCP_TEST_CONNECTORS`, which is for tests only) and point the home folder at a temporary one. They never reach a real app. The build test bundles the server, starts the bundle with the real connectors, and only lists tools and reads guides, which never reach an app either.
