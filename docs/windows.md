# Komposit on Windows

**Status: early build.** Everything below is built, unit-tested on
both systems, and smoke-tested on GitHub's `windows-latest` runner, a Windows
PC with no Adobe apps. Nothing has yet driven a real Windows Illustrator,
Photoshop or After Effects; [windows-testing.md](windows-testing.md) is the
script for that first run. The macOS app is unchanged by this work (see
[Mac behaviour](#mac-behaviour-is-unchanged)).

- [How it's put together](#how-its-put-together)
- [Every macOS piece and its Windows counterpart](#every-macos-piece-and-its-windows-counterpart)
- [Verified, and not yet verified](#verified-and-not-yet-verified)
- [Known risks](#known-risks)
- [Sources](#sources)

## How it's put together

The server, the bridges and the UI are the same code on both systems. What
differs lives in one place, **`companion/platform/`**:

| File | What |
|---|---|
| `index.mjs` | Picks `mac.mjs` or `win.mjs` at runtime (`process.platform`); lists the shared interface |
| `mac.mjs` | The macOS code, moved here unchanged: AppleScript, JXA, `pgrep`, `ps`, `mdfind`, `open`, `qlmanage`, the permission helper, the login-shell PATH, process groups |
| `win.mjs` | The Windows implementation of the same names |

Nothing outside `companion/platform/` runs `osascript`, `pgrep`, JXA,
`tasklist` or COM. The bridges call `bridges/extendscript.mjs` (the result
envelope, the ES3 JSON encoder, the After Effects result file), which calls
`platform.runJsx`.

The Windows app (`packaging/windows/`):

```
%LOCALAPPDATA%\Programs\Komposit\
  Komposit.exe          tray app          (tray/KompositTray.cs, WinForms)
  komposit-win.exe      native helper     (helper/KompositWin.cs)
  komposit.ico, tray-light.ico, tray-dark.ico, komposit.json
  node\node.exe         bundled Node 24 (x64)
  app\companion\ ui\ node_modules\ package.json
```

- **C#, not Electron or Tauri.** Both programs are C# 5 for .NET Framework 4.x,
  built with the `csc.exe` that ships with Windows. That's the compiler GitHub's
  runner uses, and a fresh checkout on any Windows 10/11 PC builds the helper
  with it on first use (`win.mjs: buildHelper`). Nothing to download, no
  toolchain to break, about 60 KB per program. Electron would add about 150 MB
  for a tray icon; Tauri needs Rust, MSVC and WebView2 and takes about 10
  minutes to build on the runner; Node tray libraries ship prebuilt native
  binaries that break across Node versions.
- **Installer:** Inno Setup 6, installed on `windows-latest`
  (`packaging/windows/komposit.iss`). Per user, no administrator prompt.
- **Build:** `node packaging/windows/build.mjs` (compile, stage, installer).
  **CI:** `.github/workflows/windows.yml` runs the unit tests, builds, smoke-tests
  (`packaging/windows/smoke.mjs`) and uploads `komposit-windows-installer`.

## Every macOS piece and its Windows counterpart

### Running scripts in the Adobe apps

| | macOS | Windows |
|---|---|---|
| Illustrator, Photoshop | `mac.mjs: runJsx` writes the script to a file, then `osascript` runs `tell application … do javascript (read file)`. The value of the script's last expression comes back on stdout. | `win.mjs: runJsx` → `komposit-win.exe jsx --progid Illustrator.Application\|Photoshop.Application` → COM `DoJavaScript(code, <missing>, 1)`. Its String result is the last expression's value [A1, A2] and is written to a UTF-8 file that Node reads. Mode `1` is `aiNeverShowDebugger` / `psNeverShowDebugger` [A1, A2], so a script error can't stop at an invisible debugger. |
| After Effects | AppleScript `DoScript` returns nothing. The wrapped script writes its JSON result to a file (`extendscript.mjs: runViaFile`). | Same file handshake, with no COM. `AfterFX.exe -r <file.jsx>` "runs the script in the existing instance" [A3]. The launcher returns immediately [A4], so `win.mjs: runAfterEffects` waits for the result file to hold complete JSON (`waitForJsonFile`), up to the step's timeout. The `.jsx` is written with a UTF-8 byte order mark, which ExtendScript reads as UTF-8 [A6]. |
| Where AfterFX.exe is | (bundle name, `AE_APP`) | The running After Effects' own path (helper `procs`), then the `App Paths\AfterFX.exe` registry entry, then the newest `Program Files\Adobe\Adobe After Effects *\Support Files\AfterFX.exe` [A3]. Install folders can be moved in Creative Cloud [A8], so the location isn't hard-coded. |
| The app is busy or showing a dialog | AppleScript times out (`-1712`), or AE's `DoScript` returns at once without running | A COM server that's busy rejects calls (`RPC_E_CALL_REJECTED`, `RPC_E_SERVERCALL_RETRYLATER` [M5]). The helper registers an `IMessageFilter` on its STA thread [M5] and retries for up to 20 s. Past that, Node's step timeout ends it with the same message as on the Mac. |
| "Allow Scripts to Write Files and Access Network" off | AE runs the script but can't write the result; `DoScript` returns at once, so Komposit says so right away (`AE_SCRIPT_FILES`) | The menu path is **Edit > Preferences > Scripting & Expressions** [A5] (`platform.aeScriptSettings`). Windows can't see "finished without writing", so `win.mjs: aeScriptWritesPref` reads `"Pref_SCRIPTING_FILE_NETWORK_SECURITY"` from `%APPDATA%\Adobe\After Effects\<ver>\Adobe After Effects <ver> Prefs.txt` (the same key the Mac's prefs file has). When it says off, Komposit waits 10 s, then reports it. |
| Script errors | the envelope `{ok, error, logs, data}`; AE scripts compiled with `eval` inside `try` | Same envelope and wrapper (`extendscript.mjs: wrap`); COM exceptions map to codes in `win.mjs: comError` |
| Activate | `osascript -e 'tell … to activate'` (also launches) | Starts the program if it isn't running, else helper `activate` (`SetForegroundWindow`, with the Alt-key tap Windows needs before a background program may change the foreground) |

### Processes, windows, dialogs

| | macOS | Windows |
|---|---|---|
| Which apps are running (`desktop.mjs`, every 2 s at most) | `pgrep -f "Adobe Illustrator"` etc. | `tasklist /FO CSV /NH` (`parseTasklist`): `Illustrator.exe`, `Photoshop.exe`, `AfterFX.exe` [A7] |
| Is it still alive after a failure (`incidents.mjs`) | `pgrep -f` with stricter patterns | the same `tasklist` check; COM's `RPC_S_SERVER_UNAVAILABLE` / `RPC_E_DISCONNECTED` count as a crash (`classify`) |
| After Effects process id and uptime (`dialogwatch.mjs: aeReady`) | `pgrep`, `ps -o etime=` | `tasklist`, helper `procs` (`Process.StartTime`) |
| Dialog notice and modal detection (`dialogwatch.mjs`) | JXA `CGWindowListCopyWindowInfo`: window layer 8 = modal | helper `windows`: `EnumWindows`, `GetWindowThreadProcessId`, `IsWindowVisible`, `IsWindowEnabled`, `GetWindow(GW_OWNER)`, class names [M6]. `win.mjs: classifyWindows` maps them to the Mac's shape: **layer 8** if the class is `#32770` ("the class for a dialog box") or if the window's owner is disabled ("the system automatically disables the window … when it creates the modal dialog box") [M6]. `dialogwatch.mjs` is unchanged. |

### Installed apps, permissions, settings

| | macOS | Windows |
|---|---|---|
| Installed? (`setup.mjs`) | Spotlight: `mdfind kMDItemCFBundleIdentifier == …` | Illustrator and Photoshop: the COM registration, `HKCR\<ProgID>\CLSID` → `LocalServer32` (`comServerPath`). After Effects: `afterEffectsExe()`. |
| Open an app | `open -b <bundle id>` | spawn the program found above |
| Permission to control the apps | the Automation (TCC) consent dialog; `komposit-helper` (`helper.swift`, `AEDeterminePermissionToAutomateTarget`); `-1743` = denied | **No such permission**: COM is open to the person's own programs. Setup shows **Test connection**, which runs a read-only script (`requestAutomation`); a success is remembered for that run of the app (`noteConnected`). |
| Design folders | `~/Desktop`, `~/Documents`, `~/Downloads`; the first read shows a macOS prompt, so they're read only after **Allow** | The known folders from `HKCU\…\Explorer\User Shell Folders` [M7] (`knownFoldersFrom`). This follows OneDrive Known Folder Move, which redirects Desktop and Documents [M7]. No prompts (`folderPrompts = false`); the UI shows them as allowed. Paths in redirected folders count as "home" for listing (`desktop.mjs: inHome`). |
| Settings panes | `x-apple.systempreferences:` URLs | none (nothing to open) |
| Open a design file | `open <path>` | helper `open` (ShellExecute) |
| File thumbnails | `qlmanage -t` | helper `thumb`: `IShellItemImageFactory::GetImage` with `SIIGBF_THUMBNAILONLY`. `.ai`/`.psd` often have no Explorer thumbnail; open documents get real renders anyway. |

### Paths, text and files

| | macOS | Windows |
|---|---|---|
| Settings, chats, incident log | `~/Library/Application Support/Komposit` | `%APPDATA%\Komposit` (`defaultDataDir`) |
| Server log | `~/Library/Logs/Komposit/server.log` (the menu-bar app writes it) | `%LOCALAPPDATA%\Komposit\Logs\server.log` (the tray app writes it) |
| Exports | `~/Komposit Exports` | `%USERPROFILE%\Komposit Exports` (same code: `files.mjs`) |
| Scratch files | `os.tmpdir()/komposit` | the same; `%TEMP%\komposit` can contain spaces (the user's name), so the preview-video path is matched to the end of the line (`cli.mjs`) |
| "Inside the home folder" checks | `startsWith(home + "/")` | case-insensitive, either slash, `..` resolved first (`isInside`) |
| Paths inside ExtendScript | `JSON.stringify(path)` | the same: backslashes come out escaped, and ExtendScript accepts `\` as a separator [A6]; `fsName` returns `C:\…` [A6] |
| Text encodings | UTF-8 throughout | Scripts go to COM as strings (no file encoding involved). AE `.jsx` files get a UTF-8 BOM [A6]. The helper writes results and JSON as UTF-8 whatever the console code page, and reads `reg`/`tasklist` output as text. |
| Line endings | n/a | the ES3 JSON encoder escapes `\r` and `\n`; `.jsx` line endings don't matter |

### The Claude Code engine (`engines/cli.mjs`, `shellenv.mjs`)

| | macOS | Windows |
|---|---|---|
| Finding `claude` | the login shell's PATH (`zsh -ilc`), because apps opened from Finder get a bare PATH; then `~/.local/bin`, Homebrew, npm | The current PATH from the registry (`HKCU\Environment`, `HKLM\…\Session Manager\Environment`), so an install made after sign-in is found. Then `%USERPROFILE%\.local\bin\claude.exe` (the native installer [C1]) and npm's `node_modules\@anthropic-ai\claude-code\bin\claude.exe`. Only `.exe`: Node refuses to spawn `.cmd` without a shell [N1], and a shell would have to quote the person's message. |
| Install command shown in the UI | `curl -fsSL https://claude.ai/install.sh \| bash` | `irm https://claude.ai/install.ps1 \| iex` [C1]. Git for Windows is optional [C1]: Komposit only uses its own MCP tools. |
| Passing the message | `-p <message>`, `--append-system-prompt <text>` | the message on **stdin**, the system prompt via `--append-system-prompt-file` [C2]. Windows limits a command line to 32,767 characters, and an attached text file alone can be 60 KB. (Checked: `claude -p` takes its prompt from stdin.) |
| Stop | kill the process group (`detached: true`, `kill(-pid)`) | `taskkill /PID <pid> /T /F` ends the tree, including the MCP doc server [N2]. Process groups don't exist on Windows [N2]. |

### The app around the server

| | macOS (`packaging/macos/`) | Windows (`packaging/windows/`) |
|---|---|---|
| The always-on part | `Komposit.swift`, menu-bar app | `tray/KompositTray.cs`, tray app |
| Starts the server | the bundled `node` runs `app/companion/server.mjs`; reads `KOMPOSIT_READY port=N`; uses an already-running server | the same, with the server in a **job object** that kills it (and anything it started) when the tray app ends, even if killed |
| Crashes | restarts the server, gives up after 5 in a minute | the same |
| Server outliving the app | the server notices it was re-parented to launchd (`ppid` changes) | `watchParent` checks the parent with `process.kill(ppid, 0)`, since Windows doesn't re-parent; the job object covers it too |
| Menu | Open, Restart, Show Log, Show Data Folder, Open at Login, Quit | the same, plus left-click or double-click to open |
| Icon | the 04.C tile as a template image (follows the menu bar) | `tray-dark.ico` on a light taskbar, `tray-light.ico` on a dark one (`SystemUsesLightTheme`), switching live |
| Open at login | `SMAppService` | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` [M10], set by the installer option and the menu |
| Opens the UI | the hosted page through `/connect` if the build has a web URL and the browser is Chromium or Firefox, else the local page | the same, with the URL in `komposit.json` (`KOMPOSIT_WEB_URL` at build time). The default browser on Windows is Chromium-based or Firefox. |
| Test switch | `KOMPOSIT_NO_BROWSER`, `KOMPOSIT_SPAWN` | `--background`, `--selftest --out <file>` |

### Packaging and first launch

| | macOS | Windows |
|---|---|---|
| Package | `build-mac.sh` → DMG, universal | `build.mjs` → Inno Setup `.exe`, x64 |
| Install | drag to Applications | per user, no admin: `PrivilegesRequired=lowest` [I1]; `{autopf}` → `%LOCALAPPDATA%\Programs` [I1]; Start-menu entry; uninstaller in Settings > Apps |
| Unsigned | Gatekeeper → **Open Anyway** in Privacy & Security | SmartScreen: **"Windows protected your PC"**, then **More info > Run anyway** [M4]. Reputation for unsigned files builds per version over weeks [M4]. **Smart App Control** blocks unsigned files outright [M4], so a PC with it on can't run this build. The download carries Mark of the Web [M4]. |
| Icon | `make-icon.swift` → `.icns` | `make-icons.swift` → `.ico` (DIB frames up to 128 px, PNG at 256) |

### The browser

| | macOS | Windows |
|---|---|---|
| Hosted page → `http://127.0.0.1` | Chrome: Local Network Access permission, one Allow; Safari: no, so it gets the app's page | Chrome and Edge: the same permission (Chrome 142+ [B1], Edge 143+ [B2]); no Windows-specific behaviour is documented [B1]. `Access-Control-Allow-Private-Network` still answers older preflights [B3]. |
| UI wording | Mac, menu bar, System Settings, macOS prompts, Cmd | PC, system tray, Start menu, no prompts, PowerShell (`ui/app.js: WORDS`). The page asks the app which system it runs on (`/api/status → platform`). |
| The model's wording | Cmd+Z, Cmd+S, "this Mac" | Ctrl+Z, Ctrl+S, "this computer" (`behavior.mjs`, `tools.mjs`, `attachments.mjs`). Fixed per machine, so the prompt cache still holds. |

### Development scripts

`npm run check` and `npm run test:live` used POSIX shell syntax (`for …; do`,
`VAR=1 cmd`), which `cmd.exe` doesn't run. They're now `scripts/check.mjs` and
`scripts/test-live.mjs`; `npm run test:live -- illustrator` runs one app.

## Verified, and not yet verified

**Verified on GitHub's Windows runner** (no Adobe apps; every CI run):

- the unit tests, including `companion/test/win.test.mjs`: registry and
  `tasklist` parsers, OneDrive folder redirection, case-insensitive path rules,
  dialog classification, COM error mapping, the AE result-file handshake and
  prefs, the helper's lookup order, the csc and Inno Setup command lines, and
  what gets staged;
- `komposit-win.exe`: `version`, `procs` (start times, paths), `windows`,
  `folders`, and `jsx` reporting `NOT_INSTALLED` for Illustrator and Photoshop;
  `thumb` is checked but optional;
- the platform layer from the staged app:
  - nothing running or installed, and "not-running" automation;
  - an empty window list, not an error;
  - absolute design-folder paths;
  - `runJsx` failing cleanly with `APP_NOT_INSTALLED`;
- the bundled server:
  - starts and serves the UI with the token;
  - `/api/status` reports `win32`;
  - setup says the apps aren't installed and the folders need no prompt;
  - the workspace and folder browsing work;
  - a turn is refused until an AI is chosen;
  - the four locks hold (host 421, origin 403, token 401, form 415);
- the tray app's `--selftest` (it starts its own server, answers `/api/hello`,
  stops it), from the build folder and again after a real install;
- the installer, silent and per user: files, Start-menu entry, uninstall.

**Verified on the runner against stand-in Adobe apps** (`packaging/windows/fake-adobe.mjs`;
21 checks, every CI run):

- **Illustrator and Photoshop: in-process JScript COM components** registered
  under the real ProgIDs. The helper's COM client works end to end:
  - ProgID lookup, `CreateInstance`, and late-bound `DoJavaScript(code, missing, 1)`;
  - the real `listDocuments` bridge scripts run through Komposit's wrapper and
    their envelope comes back;
  - debugger mode 1 arrives;
  - objects, numbers and Unicode round-trip through COM and UTF-8;
  - errors thrown in the script come back in the envelope;
  - a COM-level failure reads as the app's script error and is logged;
  - a script that doesn't parse comes back with its message ("Expected
    identifier");
  - timeouts give the Mac's message;
  - Stop is immediate.
- **After Effects: a stand-in `AfterFX.exe`** with a main window:
  - found through the running process;
  - held back until it has been up 15 s;
  - the `-r` handoff and result file work, with the UTF-8 BOM;
  - selection and error envelopes come back;
  - **both kinds of modal dialog** are detected as modal and scripts are refused
    at once: a custom window that disables its owner (520x420), and a standard
    `#32770` alert (299x130);
  - the dialog notice shows its hint and clears it;
  - timeouts give the Mac's message.

This found and fixed two real gaps:
- COM reports a failing script with the script engine's own error code
  (`0x800Axxxx`), now mapped to a script error;
- a syntax error in the agent's code used to break the whole wrapper. On Windows,
  Illustrator and Photoshop scripts are now compiled with `eval` inside the
  envelope, as After Effects scripts always are, so the error comes back with
  its message.

Not covered by the stand-ins: **out-of-process COM activation and the
busy-retry filter**. An out-of-process .NET stand-in was tried. It registered
its class object, but on GitHub's runner no activation ever reached it, and a
plain PowerShell client hung the same way. That path needs the real apps.

**Not yet verified (needs a Windows PC with Creative Cloud):**

- any real COM call into Illustrator or Photoshop (out of process, as Adobe's
  apps are), its return value, its speed, and the busy-retry filter;
- `AfterFX.exe -r` handing scripts to a running After Effects, and the timing
  of the result file;
- what Adobe's real dialogs look like to `EnumWindows` (class names, owner
  disabled or not);
- the Claude Code engine on Windows (`claude.exe` + the MCP doc server);
- the tray icon and menu on a real desktop;
- SmartScreen and the installer as a tester sees them;
- the hosted page in Chrome and Edge on Windows;
- thumbnails of `.ai`/`.psd`;
- activation (bringing an app to the front).

`windows-testing.md` covers each of these.

## Known risks

- **Adobe dialogs may not be standard dialog boxes.** Adobe draws its own UI,
  so a modal may not have class `#32770`. Detection also uses "the main window
  is disabled". If neither holds, the step still times out with the same
  message as on the Mac; only the early hint is lost.
- **A COM call into an app with a modal open may block** rather than be
  rejected. The step timeout ends it either way.
- **COM can start an app.** `CreateObject` starts the app if it isn't running
  [A1], as AppleScript does on the Mac. Komposit checks that the app is running
  before reading selections and rendering previews.
- **Smart App Control** blocks unsigned apps. Testers with it on need a signed
  build. Azure Trusted Signing (about $10/month) is the cheapest route; with an
  EV certificate, SmartScreen no longer gives a pass [M4].
- **Windows on Arm** isn't built (x64 only). It may run under emulation;
  untested.
- **Antivirus:** new unsigned programs, an installer among them, are sometimes
  flagged by heuristics. Nothing in the build does anything unusual, but expect
  the odd report until the builds are signed.

No firewall prompt: the server listens on `127.0.0.1` only, and Windows Defender
Firewall asks only about programs that accept connections from the network.

## Sources

Adobe (A):
1. Illustrator VBScript Scripting Reference (CC): `DoJavaScript` / `DoJavaScriptFile` signatures (p. 10), the `documents.length` return example (p. 13), `AiJavaScriptExecutionMode` 1 = aiNeverShowDebugger (p. 261). https://web.archive.org/web/20210507231951/https://www.adobe.com/content/dam/acom/en/devnet/illustrator/pdf/Illustrator_Scripting_Reference_VBScript_cc.pdf ; "Launching": `CreateObject("Illustrator.Application")`, https://ai-scripting.docsforadobe.dev/scripting/launching/
2. Photoshop VBScript Reference 2020: `DoJavaScript` (p. 18), `PsJavaScriptExecutionMode` 1 = psNeverShowDebugger (p. 164). https://github.com/Adobe-CEP/CEP-Resources/tree/master/Documentation/Product%20specific%20Documentation/Photoshop%20Scripting
3. After Effects Scripting Guide, overview: "`afterfx.exe -r` … does not open a new instance … it runs the script in the existing instance". https://ae-scripting.docsforadobe.dev/introduction/overview/ ; also https://helpx.adobe.com/after-effects/using/scripts.html
4. Community report that `AfterFX -r` returns immediately when After Effects is already running (not official). https://community.adobe.com/questions-529/afterfx-com-r-returns-immediately-instead-of-waiting-the-script-execution-when-ae-is-already-up-55273
5. "Windows: Select Edit > Preferences > Scripting & Expressions > Allow Scripts To Write Files And Access Network". https://helpx.adobe.com/after-effects/using/scripts.html
6. ExtendScript File and Folder objects: Unicode I/O and the BOM; `\` and `/` as separators on Windows; `fsName` vs `fullName`. https://extendscript.docsforadobe.dev/file-system-access/using-file-and-folder-objects/ , https://extendscript.docsforadobe.dev/file-system-access/file-object/
7. Program names and folders: community posts only (Illustrator: `…\Support Files\Contents\Windows\Illustrator.exe`).
8. Install locations can be changed: https://helpx.adobe.com/download-install/using/change-install-location.html

Microsoft (M):

4. SmartScreen reputation ("Windows protected your PC", "Run anyway", Smart App Control, EV no longer bypasses): https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation ; Mark of the Web: https://learn.microsoft.com/en-us/microsoft-365-apps/security/internet-macros-blocked
5. COM error codes: https://learn.microsoft.com/en-us/windows/win32/com/com-error-codes-3 ; `IMessageFilter::RetryRejectedCall`: https://learn.microsoft.com/en-us/windows/win32/api/objidl/nf-objidl-imessagefilter-retryrejectedcall ; `CoRegisterMessageFilter` (STA only): https://learn.microsoft.com/en-us/windows/win32/api/objbase/nf-objbase-coregistermessagefilter
6. `EnumWindows`, `GetWindowThreadProcessId`, `IsWindowVisible`, `IsWindowEnabled`, `GetWindow`: https://learn.microsoft.com/en-us/windows/win32/api/winuser/ ; "#32770 | The class for a dialog box": https://learn.microsoft.com/en-us/windows/win32/winmsg/about-window-classes ; modal dialogs disable their owner: https://learn.microsoft.com/en-us/windows/win32/dlgbox/about-dialog-boxes
7. `SHGetKnownFolderPath` and KNOWNFOLDERID: https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shgetknownfolderpath ; OneDrive Known Folder Move: https://learn.microsoft.com/en-us/sharepoint/redirect-known-folders ; "User Shell Folders" is the real data: https://devblogs.microsoft.com/oldnewthing/20031103-00/?p=41973
10. Run keys: https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys

Claude Code (C):
1. Install on Windows, `%USERPROFILE%\.local\bin\claude.exe`, Git for Windows optional: https://code.claude.com/docs/en/setup
2. `--append-system-prompt-file`, `--system-prompt-file`: https://code.claude.com/docs/en/cli-reference ; stdin in non-interactive mode: https://code.claude.com/docs/en/headless

Node.js (N):
1. `.bat`/`.cmd` need `shell: true` since the April 2024 security releases: https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2 ; DEP0190: https://nodejs.org/api/deprecations.html
2. `child_process` on Windows (`windowsHide`, `detached`, no process groups): https://nodejs.org/api/child_process.html ; `taskkill /t /f`: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill

Browsers (B):
1. Chrome Local Network Access (Chrome 142; covers 127.0.0.0/8): https://developer.chrome.com/blog/local-network-access
2. Edge: https://learn.microsoft.com/en-us/deployedge/ms-edge-local-network-access
3. Private Network Access preflight header: https://developer.chrome.com/blog/private-network-access-preflight

Inno Setup (I):
1. `PrivilegesRequired=lowest`, `{autopf}`: https://jrsoftware.org/ishelp/topic_setup_privilegesrequired.htm , https://jrsoftware.org/ishelp/topic_consts.htm

GitHub runner: `windows-latest` = Windows Server 2025, Inno Setup 6.7.1, .NET Framework 4.8/4.8.1, Node 22/24 (https://github.com/actions/runner-images, `images/windows/Windows2025-VS2026-Readme.md`). Billing for Windows minutes: https://docs.github.com/en/billing/concepts/product-billing/github-actions
