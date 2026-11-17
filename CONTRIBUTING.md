# Contributing

Thanks for wanting to help. Issues and small, focused pull requests are the most
useful right now, especially recipes that work (or don't) in a real app, and
anything about Windows.

## Set up

You need Node 22.18 or later. For anything beyond the unit tests you also need
Illustrator, Photoshop, After Effects or Premiere Pro.

```sh
git clone https://github.com/werqaferaw/komposit komposit
cd komposit
npm install
npm run check        # typecheck, boundary check and unit tests
```

The unit tests need no network and no creative apps, and run on macOS and Windows.

## Where things live

- `protocol/` holds the shared types. It imports nothing else in the kit.
- `toolkit/` holds the tool definitions, labels and safety rules. It imports only
  `protocol/`.
- `connectors/` holds one folder per app plus the shared `_kit/`. Connectors import
  only `protocol/`. The scripts that run inside the apps are ExtendScript (ES3): `var`,
  no arrow functions, no template strings inside the script text.
- `mcp/` is the standalone server. It may import `protocol/`, `connectors/` and
  `toolkit/`.
- `skills/` holds the skills, written from each connector's `guide.md`.
- `helper/mac/` is the Swift helper; `bridge/` is the socket bridge.

`npm run check:boundaries` enforces these lines.

## Style

- TypeScript that Node runs directly: local imports end in `.ts`, `import type` for
  types, and no enums, namespaces or parameter properties.
- Tests use `node:test` and sit next to the code as `*.test.ts`.
- Comments explain why, not what.
- Messages people read are plain sentences, never error codes or stack traces.

## Testing with the real apps

Unit tests use a fake transport. If you test against a real app, use a throwaway
document: edits run in whatever document is active.

## License

By contributing you agree that your work is released under the
[Apache License 2.0](LICENSE).
