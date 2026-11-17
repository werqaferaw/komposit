# komposit-helper (Mac)

A small Swift program that runs beside the core and does the things only a native
Mac program can do well: send scripts to the creative apps over Apple Events, check
permissions, list windows, read and answer dialogs through Accessibility, report
heat, keep the Mac awake, move files to the Trash and draw QuickLook previews.

Started as `komposit-helper bridge`, it is something else: the bridge an AI starts to
reach the core's toolbox (see [The bridge](#the-bridge) below).

The TypeScript client lives in the core, not here. This folder holds the program,
its build, a smoke test and the steps for the live test.

| File | What it is |
| --- | --- |
| `Sources/main.swift` | the method table and the stdin loop (`bridge` is told apart first) |
| `Sources/Bridge.swift` | `komposit-helper bridge`: the AI's way to the toolbox |
| `Sources/RPC.swift` | JSON-RPC over stdio, errors, param helpers |
| `Sources/AppleEvents.swift` | `appleEvents.runScript`, `appleEvents.permission` |
| `Sources/Windows.swift` | `windows.list` and the dialog guess |
| `Sources/Accessibility.swift` | `ax.trusted`, `ax.dialog`, `ax.press` |
| `Sources/System.swift` | `system.thermal`, `power.assertion`, `files.trash`, `quicklook.thumbnail` |
| `Info.plist` | embedded into the binary: name and the Automation reason |
| `build.sh` | builds `out/helper/komposit-helper` |
| `smoke.test.ts` | spawns the built helper and checks the safe methods |
| `live-bundle.sh`, `LIVE-TEST.md` | the live checks with real apps, done by hand |

## Build and test

```sh
helper/mac/build.sh                    # -> out/helper/komposit-helper (universal arm64 + x86_64)
node --test helper/mac/smoke.test.ts   # builds first if the binary is missing
```

`build.sh` compiles each architecture with `swiftc` (Swift 5 language mode, macOS 12
minimum, whole-module optimised), joins them with `lipo`, and signs the result
ad hoc. If the other architecture fails to compile it falls back to this Mac's own
and says so. No Xcode project, no packages.

## Running it

Start `komposit-helper` with no arguments and pipes on stdin and stdout. Each line in
is one JSON-RPC 2.0 request; each line out is one response or notification. Requests
run concurrently, so **replies can come back out of order**: match them by `id`. A long
script never holds up a `ping`.

When stdin closes (the core quit or crashed), the helper finishes what is running,
releases its power assertion and exits with code 0. Every method has a time limit,
so that never hangs.

stderr is not used for protocol traffic.

### Notifications from the helper

| Method | Params | When |
| --- | --- | --- |
| `ready` | `{ version, protocol, arch }` | once, at start. Wait for it before the first call |
| `system.thermalChanged` | `{ state, lowPowerMode }` | the Mac's heat level changed |

### Errors

Every error has a plain-sentence `message` (shown to the person as is) and
`data.kind`, the stable name the core branches on. Some add more fields to `data`.

| `data.kind` | `code` | Meaning |
| --- | --- | --- |
| `notRunning` | -32010 | the app isn't open (or closed mid-script) |
| `automationDenied` | -32011 | the person said no to Automation for that app (-1743) |
| `timeout` | -32012 | the app (or QuickLook) didn't answer in time |
| `scriptError` | -32013 | the script ran and failed; `message` is the app's own text |
| `notTrusted` | -32014 | Accessibility is off for Komposit |
| `notFound` | -32015 | no such dialog, button or file |
| `failed` | -32016 | anything else; `data.osStatus` / `axError` / `ioReturn` say more |
| `invalidParams` | -32602 | a missing or wrong parameter |
| `methodNotFound` | -32601 | unknown method |
| `parse` | -32700 | the line wasn't JSON (`id` is null) |

## Methods

### `ping`
`{}` -> `{ pong: true, t }` (`t` = ms since 1970).

### `version`
`{}` -> `{ name: "komposit-helper", version, protocol: 1, arch: "arm64" | "x86_64", os: "15.7.4", pid }`.

### `appleEvents.runScript`
Runs code inside an app that is **already open**. It never launches an app.

Params:
- `bundleId` (string) and/or `pid` (number): which app. With both, the pid must belong
  to that bundle id. After Effects versions share one bundle id
  (`com.adobe.AfterEffects.application`); pass `pid` when two are open.
- `code` (string): the script text, sent as is (no escaping needed).
- `timeoutMs` (number, default 120000, minimum 1000).
- `verb`: `"javascript"` (default) sends `do javascript` (event `misc/DjxM`:
  Illustrator, Photoshop); `"doScript"` sends After Effects' `DoScript` (`misc/dosc`),
  which returns nothing, so have the script write its result to a file as 1.0 did.

Result: `{ result: string, app: "Illustrator", pid, ms }`. `result` is the script's
last expression as text.

Errors: `notRunning`, `automationDenied`, `timeout` (the step may still finish in the
app, and the message says to check before retrying), `scriptError` (`data.appError` is
the app's error number), `failed` (`data.osStatus`).

The first call to an app whose Automation answer isn't decided shows macOS's prompt.
The core should check `appleEvents.permission` first and ask in context.

### `appleEvents.permission`
Params: `{ bundleId, ask?: false }`. With `ask: true`, macOS shows its consent dialog
when the answer isn't decided yet and the app is running; the call waits for it.

Result: `{ status, osStatus }`, `status` one of `granted` (0), `denied` (-1743),
`notDetermined` (-1744), `notRunning` (-600), `unknown` (anything else).

### `windows.list`
CoreGraphics' window list. No permission needed; a few milliseconds.

Params (all optional):
- `pid`: only that process's windows.
- `ownerPrefix`: only windows whose owner name starts with this ("Adobe Illustrator").
- `baseline`: window ids seen earlier (when a step started); turns on `dialogs.new`.
- `onScreenOnly`: default false (1.0 listed all windows: a dialog may be off screen while it opens).

Result:
```
{ windows: [{ id, pid, owner, layer, bounds: { x, y, w, h }, onScreen, alpha, title? }],
  dialogs: { modal: [ids], new: [ids] | null } }
```
- `title` appears only with the Screen Recording permission; it is never asked for.
- `dialogs.modal`: windows on layer 8 at least 150 x 80. Reliable for After Effects
  (its alerts and script errors are modal and block every later script). **Not** for
  Illustrator, which always keeps a layer-8 window.
- `dialogs.new`: windows at least 150 x 80 that are not in `baseline`. 1.0's rule
  (dialogwatch.mjs): a new window that is still there on the next look (2.5 s later)
  is almost certainly a dialog; one that's gone was a throwaway (an export's temp
  document). The core does the "still there" part.

### `ax.trusted`
Params: `{ prompt?: false }`. Result: `{ trusted }`. `prompt: true` shows the system's
Accessibility prompt; per the architecture, only the first time a dialog blocks work.

Note: a program started from Terminal is judged by Terminal's permission. Inside
Komposit.app it is Komposit's.

### `ax.dialog`
Params: `{ pid }`. Result:
```
{ dialogs: [{ kind: "dialog" | "sheet", title, text: [..], buttons: [..], fields,
              defaultButton?, cancelButton? }] }
```
Frontmost first, at most 4; empty when there is none. Dialogs are windows with subrole
`AXDialog`/`AXSystemDialog` plus sheets. Per dialog it looks at 160 elements at most and
keeps up to 12 texts (600 chars each) and 8 buttons, skipping the window's own
close/minimise/zoom buttons. Some Adobe dialogs are drawn by the app and expose nothing:
those come back with empty `text` and `buttons`. Each call to the app waits 3 s at most.

Errors: `notRunning`, `notTrusted`.

### `ax.press`
Params: `{ pid, button }` presses the button with that name (any case) in the frontmost
dialog that has one; or `{ pid, key: "return" | "escape" }` presses the dialog's default
or cancel button. Result: `{ pressed: "Cancel" }`.

The helper presses what it is told. **The core decides** which buttons an agent may press
on its own (never Save, Don't Save, Discard, Delete, Replace, Overwrite, Revert, Quit:
1.0's `agentMayPress`).

Errors: `notRunning`, `notTrusted`, `notFound` (no dialog, or no such button), `failed`.

### `system.thermal`
`{}` -> `{ state: "nominal" | "fair" | "serious" | "critical", lowPowerMode }`.
Changes also arrive as `system.thermalChanged`.

### `power.assertion`
Params: `{ on: boolean, reason?: string }`. Holds at most one "prevent idle sleep"
assertion (the display may still sleep). Result: `{ on, changed }`. Released when turned
off or when the helper exits.

### `files.trash`
Params: `{ paths: [absolute paths] }`. Moves each to the Trash with the system call (the
person can put it back; no Finder automation). Result:
`{ results: [{ path, ok: true, trashedTo } | { path, ok: false, error }] }`, one per path,
in order. The core decides which paths are allowed.

### `quicklook.thumbnail`
Params: `{ path, size?: 400 (16..2048), timeoutMs?: 20000, allowIcon?: false }`.
Result: `{ png: base64, width, height, type: "thumbnail" | "lowQualityThumbnail" | "icon" }`.
Without `allowIcon`, a file macOS can only show as an icon fails with `failed`. It gives
up after `timeoutMs` (1.0's qlmanage could hang for good on `.aep` files).

## The bridge

`komposit-helper bridge` is what an AI's own process (Claude Code, Codex) starts from the MCP
config Komposit writes, in the Mac app. It does what `bridge/bridge.ts` does on Node in
development and on Windows, with the same plain sentences, byte for byte; `bridge/bridge.test.ts`
puts both through the same cases. The Mac app needs its own because its Electron doesn't run as
Node: the RunAsNode fuse is off, so no other program can start the app's signed binary as Node
and run code with its identity and the person's Automation permission.

- Settings: `KOMPOSIT_SOCKET` (the toolbox's Unix socket) and `KOMPOSIT_PASS` (this run's pass).
- stdin/stdout: MCP's stdio transport, one JSON-RPC message per line. Every line is relayed to
  the core after `{"komposit_pass": ...}`; lines sent before the core answers wait, in order.
  Blank lines are skipped and a `\r` before the `\n` is dropped; lines that aren't JSON pass as
  they are.
- No core, or the pass refused: every request (a string `method` and an id that isn't null) gets
  `{"jsonrpc":"2.0","id":<its id>,"error":{"code":-32000,"message":<sentence>}}`, then the bridge
  exits 0. The sentence is "Komposit isn't running." (no socket, or it closed), "Komposit isn't
  answering." (no answer to the pass in 10 s) or the core's own. With nothing to answer it waits
  30 s for a request, then exits.
- The core going away while relaying: each request still open gets "Komposit stopped before
  this finished.", then exit 0. stdin closing: the socket is half-closed and the bridge exits 0;
  stdout breaking (the AI went away) also ends it with 0.
- It never says `ready`, sends no Apple Event and needs no permission: the check for `bridge`
  comes before anything else in `main.swift`.

## Measurements (Intel Mac, macOS 15.7, Nov 15)

- Binary: 521,296 bytes universal (arm64 + x86_64; 419,920 before the bridge). About 2.9 MB in
  memory.
- `bridge` (Nov 16): 17 ms from start to the first answer relayed through a local socket, 2.6 MB
  resident (Electron as Node: 140 ms, 38 MB); a 6.8 MB line each way in about 0.3 s.
- Startup to `ready`: about 10-13 ms warm. The first run after a fresh build takes
  0.6-4 s while macOS checks the newly signed binary.
- `ping` round trip from Node: about 0.25 ms.
- `windows.list`: about 5-7 ms (197 windows), vs about 100 ms for 1.0's JXA.
- `quicklook.thumbnail` of a text file: 50-300 ms.

## For the integrator

- In the Mac app the bridge is `{ command: Contents/MacOS/komposit-helper, args: ["bridge"] }`
  (`shell/config.ts`), with no `ELECTRON_RUN_AS_NODE`.
- Spawn `out/helper/komposit-helper` (inside the app: `Komposit.app/Contents/MacOS/`, or
  wherever packaging puts it) with stdio pipes; wait for `ready`; keep one per core.
- `protocol/rpc.ts`'s `createPeer` works over it with a line-delimited transport. Map
  `data.kind` to the core's own errors and show `message` as is.
- The core's own `PlatformOps.trash` can be `files.trash`; throw if any result is not ok.
- macOS names the app that started the helper in its prompts, so in development
  (started from a terminal) the prompts and permissions are the terminal's.
