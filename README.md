# komposit

Connectors that let any AI work inside Illustrator, Photoshop, After Effects and Premiere Pro.

This is the open part of [Komposit](https://komposit.werq.dev), a free desktop app
where an AI works inside your own creative apps, with your own AI plan. The app is
built on this kit. You can use the kit without the app: plug the MCP server into
Claude Desktop, Claude Code, Codex, OpenCode or any other app that speaks MCP, and
your AI can look at your open documents, edit them, export and save.

## What's inside

| Folder | What it is |
| --- | --- |
| `connectors/` | One connector per app (`illustrator/`, `photoshop/`, `aftereffects/`, `premiere/`) and the shared kit (`_kit/`): how to reach the app on Mac and Windows, run a script, read the result, watch for dialogs. Premiere Pro has no outside scripting door, so its connector brings a small panel that runs inside it (`premiere/panel/`). Each has a `guide.md` with tested recipes. |
| `toolkit/` | The tool definitions every AI gets (inspect, edit, undo, render, export, save, open, place, guide, file tools), their plain labels, and the safety rules. |
| `mcp/` | `komposit-mcp`, a standalone MCP server over stdio that serves the toolkit with the connectors. |
| `skills/` | The same recipes as skills, in the format Claude Code and other agents read. |
| `protocol/` | The shared types: tools, connectors, the wire messages. Everything else depends on it, and it depends on nothing. |
| `bridge/` | A small program that connects an AI app to a toolbox served on a local socket. The Komposit app uses it; it is here because it is part of how AIs connect. |
| `helper/mac/` | A small Swift program for what only a native Mac program does well: Apple Events, the window list, reading and answering dialogs through Accessibility, the Trash, QuickLook previews. |

The Komposit app adds the rest: chats, approvals you click, projects, the record of
what happened, and the window. That part is not open source; the app is free.

## Quick start

You need Node 22.18 or later and at least one of Illustrator, Photoshop, After
Effects or Premiere Pro. Premiere Pro also needs the kit's small panel inside it
(see `mcp/README.md`).

```sh
git clone https://github.com/werqaferaw/komposit komposit
cd komposit
npm install
npm run build        # -> out/mcp/komposit-mcp.mjs
```

Then point your AI app at the server. Use the full path to `out/mcp/komposit-mcp.mjs`
in your checkout wherever `/path/to/komposit` appears below.

**Claude Desktop.** Settings > Developer > Edit Config, then add:

```json
{
  "mcpServers": {
    "komposit": {
      "command": "node",
      "args": ["/path/to/komposit/out/mcp/komposit-mcp.mjs"]
    }
  }
}
```

**Claude Code.**

```sh
claude mcp add komposit -- node /path/to/komposit/out/mcp/komposit-mcp.mjs
```

**Codex.** In `~/.codex/config.toml`:

```toml
[mcp_servers.komposit]
command = "node"
args = ["/path/to/komposit/out/mcp/komposit-mcp.mjs"]
# Renders and exports can take a while (an After Effects video can take minutes):
tool_timeout_sec = 600
```

**OpenCode.** In `opencode.json`:

```json
{
  "mcp": {
    "komposit": {
      "type": "local",
      "command": ["node", "/path/to/komposit/out/mcp/komposit-mcp.mjs"],
      "enabled": true
    }
  }
}
```

Start a new chat and ask for something small, like "what's in my open Illustrator
document?". The first time, macOS asks whether your AI app may control the creative
app. Say OK, or the connector can't reach it. If you said no, turn it on in System
Settings > Privacy & Security > Automation.

More settings, and every tool in detail, are in [mcp/README.md](mcp/README.md).

**Skills.** Copy the folders in `skills/` into your agent's skills folder (for Claude
Code, `~/.claude/skills/`). They teach the AI the recipes that work in each app;
they're most useful together with the MCP server.

## The safety model

The AI works in the documents you have open, so the kit is careful about what it
can reach.

- **Reads are free, changes are tools.** `inspect`, `render` and `guide` never change
  anything. Every change goes through a named tool, so your AI app can ask you before
  it runs one.
- **Edits are checked before they reach the app.** Edit code is scanned for things
  that reach outside the document: deleting, renaming, running, writing or copying
  files on your computer, saving or exporting to a path, rendering, running commands,
  quitting the app, closing without saving, running other scripts, recorded actions or code built while
  it runs, network sockets, saving from a script. The MCP server refuses those edits and says why, unless you started it with
  `KOMPOSIT_ALLOW_RISKY_SCRIPTS=1`. The scan is a seatbelt, not a lock: code built to
  hide what it does can get past any scan, so your AI app's approval is still the
  brake.
- **Edits can be undone.** Edits go into the app's own undo history, and `undo` takes
  them back step by step, as you would by hand.
- **Nothing is saved unless you ask.** Your document is saved only through the `save`
  tool, never from an edit.
- **Exports never overwrite.** A file the kit writes never replaces an existing one; it
  gets " 2", " 3" and so on. Exports land in your home folder (`~/Komposit Exports`
  by default), and paths can't follow a link out of the folder they were given.
- **Dialogs don't hang the AI.** A dialog in the app blocks its scripts. The
  connector notices and says so in a sentence, instead of waiting forever, and leaves
  the buttons to you.
- **The kit stays on your computer.** It talks to the apps on your machine and to the
  AI app that started it. It sends no telemetry and opens no network connections of
  its own. What your AI app sends to its own AI service (your words, the pictures of
  your document) is up to that app and that service.

Found a way around any of this? See [SECURITY.md](SECURITY.md).

## Platforms

- **macOS:** the main platform. Apps are reached over Apple Events. The Komposit app
  uses these same connectors.
- **Premiere Pro**, on both: through the kit's panel inside it (a CEP extension that
  takes scripts on 127.0.0.1, with a token), not through the system.
- **Windows:** the code is included (Illustrator and Photoshop are reached over COM,
  After Effects through its command line) and the unit tests run on Windows in CI,
  but it has had far less testing with the real apps. It also needs a small Windows
  helper program, `komposit-win.exe`, which isn't in this repository yet, so Windows
  doesn't work from the kit alone today. If you have one, point
  `KOMPOSIT_WIN_HELPER` at it. Reports are welcome.

## Develop

```sh
npm test               # unit tests: no network and no creative apps needed
npm run typecheck
npm run check:boundaries
npm run build:helper   # macOS: builds helper/mac into out/helper
npm run test:helper    # macOS: smoke test for the helper
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Illustrator, Photoshop, After Effects and Premiere Pro are the names of their owners' products.
This project is not made, endorsed or supported by them.
