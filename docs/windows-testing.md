# First test of Komposit on a real Windows PC

The Windows build passes its automated checks on a PC **without** Adobe apps
(see [windows.md](windows.md#verified-and-not-yet-verified)). This script is
the first run **with** Illustrator, Photoshop and After Effects. It takes about
an hour. Each step says what passing looks like; write down what you see,
especially when it doesn't pass.

A person can follow it, and so can a coding agent (such as Claude Code) running
on that PC: agents should read [Fixing what breaks](#fixing-what-breaks) first.

## You need

- Windows 10 or 11, 64-bit, signed in as a normal user.
- Creative Cloud with **Illustrator, Photoshop and After Effects** installed,
  signed in, each opened once.
- Chrome or Edge.
- An AI: a Claude Pro/Max plan with Claude Code, or an Anthropic API key.
- The installer: `Komposit-Setup-win.exe` from the release, or the
  `komposit-windows-installer` artifact of the newest green
  [windows workflow run](https://github.com/werqaferaw/komposit/actions/workflows/windows.yml).

Keep a results table as you go (template at the end).

## 1. Install (10 min)

1. Run `Komposit-Setup-win.exe`.
2. SmartScreen shows **"Windows protected your PC"**: click **More info**, then
   **Run anyway**. *(Record exactly what it showed. If it shows no "Run anyway"
   at all, Smart App Control is on and blocks unsigned apps: note it and stop.)*
3. In the installer, keep **Start Komposit when I sign in**, finish with **Open
   Komposit** ticked.

**Pass:**
- no administrator prompt;
- Komposit is in the Start menu;
- the Komposit tile appears in the system tray (it may be behind the **^**),
  dark on a light taskbar, light on a dark one;
- the browser opens `http://127.0.0.1:4321/` showing "How should Komposit think?".

Check from PowerShell:

```powershell
$k = "$env:LOCALAPPDATA\Programs\Komposit"
Get-ChildItem $k                                       # Komposit.exe, komposit-win.exe, node, app, *.ico
Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run | Select-Object Komposit
Get-Content "$env:LOCALAPPDATA\Komposit\Logs\server.log" -Tail 5   # KOMPOSIT_READY port=4321
```

## 2. Onboarding (5 min)

1. **AI.**
   - **Claude subscription:** if Claude Code isn't installed, the page shows
     `irm https://claude.ai/install.ps1 | iex`. Run it in PowerShell, run `claude`
     once to sign in, then **Check again**.
   - **Anthropic API key:** paste it.
2. **Connect your Adobe apps.** Open all three. Let After Effects finish starting.
   Click **Test connection** on each.
3. **Design folders** should already say *Allowed* (Windows has no prompt for
   them).

**Pass:**
- each app turns **Connected** within a few seconds;
- After Effects, if its scripting setting is off, says *"Turn on Edit >
  Preferences > Scripting & Expressions > Allow Scripts to Write Files…"*: turn
  it on, **Test again**, and it shows **Connected**;
- nothing hangs for more than about 20 s.

## 3. The helper, directly (5 min)

```powershell
$h = "$env:LOCALAPPDATA\Programs\Komposit\komposit-win.exe"
& $h version
& $h procs --names Illustrator,Photoshop,AfterFX       # one row per app, with startedMs and path
& $h folders                                            # where Desktop/Documents/Downloads really are
& $h windows --names Illustrator                        # top-level windows
Set-Content "$env:TEMP\t.jsx" "app.documents.length" -Encoding utf8
& $h jsx --progid Illustrator.Application --script "$env:TEMP\t.jsx" --out "$env:TEMP\t.txt"; Get-Content "$env:TEMP\t.txt"
& $h jsx --progid Photoshop.Application  --script "$env:TEMP\t.jsx" --out "$env:TEMP\t.txt"; Get-Content "$env:TEMP\t.txt"
```

**Pass:**
- `procs` lists each app with its path;
- each `jsx` prints the number of open documents, in well under a second once
  the app is up;
- an exit code of 3 (`NOT_INSTALLED`) or 5 (`GONE`) is a **fail**: record the
  JSON it printed on stderr.

## 4. Illustrator (10 min)

1. In Komposit: **New document** card > Illustrator > Square 1080.
2. Ask: *"Navy background, a coral circle in the middle, and the headline 'Hello
   Windows' in white under it."*
3. Select the circle in Illustrator and ask: *"make this blue"*.
4. Ask: *"export a print-ready PDF"*, then *"export a PNG"*.
5. In Illustrator, press **Ctrl+Z** a few times.

**Pass:**
- the steps show live and the result render shows the design; note the total
  time;
- step 3 changes only the circle, and the step list says "Selected: …";
- the PDF and PNG land in `%USERPROFILE%\Komposit Exports`, and the PDF opens;
- the open document keeps its name and is still unsaved;
- Ctrl+Z walks the edits back.

## 5. Photoshop (10 min)

1. New document, Photoshop, 1080 x 1080.
2. Ask: *"Dark gradient background and a white text layer 'Komposit', 120 px,
   centered."*
3. Select the text layer and ask: *"make this smaller and move it to the top."*
4. Ask: *"export a PNG"*, then *"save a copy"*.

**Pass:**
- the layers appear and the render matches;
- step 3 works on the selected layer;
- the PNG and a `.psd` copy land in `Komposit Exports`;
- History shows the edits.

## 6. After Effects (15 min)

1. After Effects with a new, empty project, fully started.
2. Ask: *"Make a 5 second 1080p comp with the word 'Komposit' fading in over the
   first second, then show me a preview video."*
3. Select the text layer's Opacity keyframes and ask: *"ease these."*
4. Ask: *"export an MP4."*

**Pass:**
- the comp is built;
- the chat shows a frame strip, then a preview video that plays;
- step 3 eases the selected keyframes;
- the MP4 lands in `Komposit Exports`;
- no step waits on After Effects for more than a few seconds before it starts
  working (that's the `AfterFX.exe -r` handoff). Note how long the first step
  took.

## 7. Dialogs (10 min)

1. **Illustrator:** open **File > Document Setup** and leave it open. In
   Komposit ask *"what's in this document?"*.
   - **Pass:** within about 10 s the step says *"Illustrator seems to be showing
     a dialog. Close it and this carries on."*
   - Close the dialog: the step finishes.
2. While a dialog is open, record what Windows sees:
   `& $h windows --names Illustrator`. Copy the rows whose `title` looks like
   the dialog (`cls`, `owner`, `ownerEnabled`, `enabled`).
3. **After Effects:** open **Composition > Composition Settings**, leave it
   open, and send any request.
   - **Pass:** it answers at once with *"After Effects is showing a dialog…"*.
     It must not hang.
   - Record `& $h windows --names AfterFX` too.
4. **Photoshop:** open **Image > Image Size** and send a request.
   - **Pass:** a dialog hint, or the step finishes after you close the dialog.

## 8. The incident log (2 min)

Open `%APPDATA%\Komposit\incidents.jsonl` (tray icon > **Show Data Folder**).
From a checkout, `npm run incidents` groups it.

**Pass:** the dialog tests left rows (app, kind, message, script), and no
crash rows.

## 9. The tray app (5 min)

1. Tray menu > **Restart**: the browser page reconnects.
2. Tray menu > **Show Log** and **Show Data Folder**: both open.
3. **Open at Login**: untick it, then check the `Run` key from step 1 is gone;
   tick it again.
4. Switch Windows between light and dark (Settings > Personalization > Colors):
   the tray tile follows.
5. In Task Manager, end `Komposit.exe`. Then
   `Get-Process node -ErrorAction SilentlyContinue` must show no Komposit node
   (the job object ends it).
6. Start Komposit again from the Start menu.

## 10. The hosted page (5 min, if app.komposit.werq.dev is live)

In Chrome and in Edge, open https://app.komposit.werq.dev.

**Pass:**
- the browser asks to connect to apps on this device; after **Allow**, the
  workspace appears;
- Settings says "connected from the web to the app on your PC".

## 11. Uninstall (2 min)

Settings > Apps > Installed apps > Komposit > **Uninstall**.

**Pass:**
- `%LOCALAPPDATA%\Programs\Komposit` is gone, the `Run` value is gone, and the
  tray icon is gone;
- `%APPDATA%\Komposit` (settings, chats) is still there; it's kept on purpose.

## Results template

| # | Step | Pass? | Time | Notes (errors, what you saw) |
|---|---|---|---|---|
| 1 | Install, SmartScreen, tray, browser | | | |
| 2 | Onboarding, Test connection x3 | | | |
| 3 | Helper: procs, folders, jsx IL + PS | | | |
| 4 | Illustrator: build, selection, PDF, PNG, undo | | | |
| 5 | Photoshop: build, selection, PNG, copy | | | |
| 6 | After Effects: comp, frames, preview video, keys, MP4 | | | |
| 7 | Dialogs: IL hint, AE refusal, PS; window rows recorded | | | |
| 8 | Incident log | | | |
| 9 | Tray: restart, log, login, theme, kill | | | |
| 10 | Hosted page (Chrome, Edge) | | | |
| 11 | Uninstall | | | |

Post the table in [an issue](https://github.com/werqaferaw/komposit/issues) with
`%LOCALAPPDATA%\Komposit\Logs\server.log`, `%APPDATA%\Komposit\incidents.jsonl`
and the window rows from step 7 (remove anything private first).

## Fixing what breaks

This is for whoever fixes problems the script finds, a person or a coding
agent. The build has had little time with real Adobe apps on Windows, so expect
to fix things, and leave a clear record.

**Ground rules:**
- **Never touch the owner's documents.** Make your own (New document, or
  `app.documents.add()` in a test), and close them **without saving** when
  you're done. Don't save over any file.
- Kill or restart an Adobe app only if the owner says so. A dialog you can't
  close is theirs to close.
- Work on a branch (`git switch -c windows-first-run`) and commit each fix with
  what it fixed.

**Set up a checkout** (the installer is for testers; fixes need the repo):

```powershell
winget install OpenJS.NodeJS          # Node 22 or 24, if node -v fails
git clone https://github.com/werqaferaw/komposit.git ; cd komposit
npm ci
npm test                              # the unit tests, including companion/test/win.test.mjs
npm run serve                         # http://127.0.0.1:4321 using this checkout's code
```

The first Adobe call compiles the helper into `%APPDATA%\Komposit\bin` with
Windows' own `csc.exe`. To build it yourself: `node packaging/windows/build.mjs compile`
(it lands in `packaging\windows\build\`, which the server prefers). If the
installed Komposit is running, quit it from the tray first: both use port 4321.

**Live tests** (the same ones the Mac runs; they make and close their own
documents and check the open documents are untouched):

```powershell
npm run test:live -- illustrator      # Illustrator open
npm run test:live -- api-engine       # Photoshop open: inspects its active document
npm run test:live -- aftereffects     # After Effects open with an EMPTY, untitled project
```

**Where things live:**

| Symptom | Look at |
|---|---|
| A script never reaches Illustrator/Photoshop; exit codes 3, 4, 5, 7 | `companion/platform/win.mjs: runJsx, comError`; `packaging/windows/helper/KompositWin.cs: Jsx, ComFail` |
| After Effects steps time out, or never start | `win.mjs: runAfterEffects, afterEffectsExe, waitForJsonFile, aeScriptWritesPref`; is `AfterFX.exe -r` really handing over to the running instance? |
| Dialogs not noticed, or false alarms | `win.mjs: classifyWindows` (layer 8 = modal), using the window rows from step 7; `dialogwatch.mjs` |
| Wrong app state in setup (installed/running/connected) | `win.mjs: installedApps, comServerPath, runningApps, automationState` |
| Claude Code not found or not starting | `win.mjs: extraBinDirs, loginPath, claudeNames`; `engines/cli.mjs` (stdin prompt, `--append-system-prompt-file`) |
| Tray, log, restart, login | `packaging/windows/tray/KompositTray.cs` |
| Paths, folders | `win.mjs: isInside, knownFoldersFrom`; `desktop.mjs` |

After each fix:
- `npm test` must still pass;
- re-run the step that failed;
- add a unit test in `companion/test/win.test.mjs` for anything you can
  reproduce from recorded output (window rows, error JSON, registry text).

Finally, update the "Verified, and not yet verified" section of
`docs/windows.md` with what's now verified.
