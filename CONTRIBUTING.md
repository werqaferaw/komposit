# Contributing

Thanks for wanting to help. Komposit is young, so issues and small, focused
pull requests are the most useful right now.

## Set up

You need Node 22 or later, and for anything beyond the unit tests, Adobe
Illustrator, Photoshop or After Effects.

```bash
git clone https://github.com/werqaferaw/komposit.git
cd komposit
npm install
npm run serve        # the local server and UI at http://127.0.0.1:4321
```

Choose an AI in the UI's settings. In a checkout, a `.env` file (see
`.env.example`) also works; `MODEL_PROVIDER=cli` uses Claude Code.

## Before you open a pull request

```bash
npm test             # unit tests: no network, no Adobe apps, Mac and Windows
npm run check        # every module parses
npm run test:live    # optional: drives the open Adobe apps
```

Windows changes are built and smoke-tested by the `windows` GitHub Actions
workflow on every push.

## Where things live

[docs/architecture.md](docs/architecture.md) is the map. In short:

- `companion/` is the local server. Everything OS-specific is in
  `companion/platform/` (`mac.mjs`, `win.mjs`); the rest is shared.
- `companion/bridges/` holds the per-app ExtendScript.
- `companion/harness/` is the agent: system prompt, tools, the turn loop.
- `ui/` is the one UI, served locally or by `web/`.
- `packaging/` builds the Mac app and the Windows installer.

## Style

- Plain modern JavaScript (ES modules), no build step for the server or UI.
- ExtendScript inside the bridges is ES3: `var`, no arrow functions, no
  template strings.
- Comments explain why, not what.
- User-facing text is short and plain. No emoji in the UI.

By contributing you agree that your work is released under the
[MIT License](LICENSE).
