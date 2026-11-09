# Releasing

How a Komposit release is built and published. The download links on the
[Releases page](https://github.com/werqaferaw/komposit/releases) never change
between versions:

- `https://github.com/werqaferaw/komposit/releases/latest/download/Komposit-mac.dmg`
- `https://github.com/werqaferaw/komposit/releases/latest/download/Komposit-Setup-win.exe`

## A new version

1. Bump `version` in `package.json` and update `docs/release-notes.md`
   (it becomes the release text).
2. **Mac** (on a Mac with the Xcode command-line tools):
   ```bash
   KOMPOSIT_WEB_URL=https://app.komposit.werq.dev packaging/release-mac.sh
   ```
   It runs the tests, builds the universal app, checks the DMG with
   `packaging/verify-dmg.sh`, and leaves `dist/Komposit-mac.dmg`. Without
   `KOMPOSIT_WEB_URL` the menu opens the app's own local page instead of the
   hosted one.
3. **Windows:** push to `main` and wait for the green `windows` workflow run.
   It builds the installer on a Windows runner and keeps it as an artifact.
4. **Publish** (needs the GitHub CLI, signed in with access to the repo):
   ```bash
   packaging/publish-release.sh             # Mac + Windows
   packaging/publish-release.sh --mac-only  # Windows later
   ```
   It takes the Windows installer from the newest green run, writes
   `SHA256SUMS.txt`, creates or updates the release, and checks both links.

UI-only changes reach everyone on the hosted page with `cd web && npm run deploy`,
without a new download, as long as the local server's API is unchanged.

## The hosted UI and the invite gateway

Both are Cloudflare Workers and both are optional: the app serves its own UI
locally, and people can bring their own AI.

- **Hosted UI** (`web/`): `cd web && npm run deploy`. It serves the same `ui/`
  files at `app.komposit.werq.dev`; the local server only trusts the origins
  listed in `companion/auth.mjs` (plus any you add with `KOMPOSIT_WEB_ORIGINS`).
- **Invite gateway** (`gateway/`): `gateway/setup.sh` creates the KV
  namespaces, stores the Anthropic key as a secret, deploys and checks it. Use a
  dedicated key with a monthly spend limit; that limit is the hard ceiling.
  Invites:
  ```bash
  cd gateway
  node scripts/mint-invite.mjs "Name" [--daily 300] [--monthly-output 2000000]
  node scripts/mint-invite.mjs revoke <code>
  ```
  See [gateway/README.md](../gateway/README.md) for limits and the Workers plan.
