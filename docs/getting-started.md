# Getting started with Komposit

Komposit is a design agent that works directly in your open Illustrator,
Photoshop and After Effects documents. You describe a change; it makes it in the
live file, renders the result to check its work, and tells you what it did. It
saves your file only when you ask: every change is in the app's undo history.

About 5 minutes from download to your first edit.

## You need

- **A Mac** with macOS 13.5 or later (Apple silicon or Intel), **or a PC** with
  Windows 10 or 11, 64-bit (early build, see below).
- Illustrator, Photoshop or After Effects.
- One of these for the AI:
  - a **Claude Pro or Max** plan, with Claude Code installed;
  - an **Anthropic API key**;
  - an **OpenRouter** (or other OpenAI-compatible) key, with a model that can see images;
  - an **invite code**, if you were given one.

## 1. Install

### Mac

1. Download **[Komposit-mac.dmg](https://github.com/werqaferaw/komposit/releases/latest/download/Komposit-mac.dmg)** and open it.
2. Drag **Komposit** into **Applications**.
3. Open Komposit from Applications. macOS says it can't check Komposit for
   malicious software, because this preview isn't signed with an Apple
   developer certificate. Click **Done**.
4. Open **System Settings > Privacy & Security**, scroll down to
   *"Komposit was blocked to protect your Mac"*, click **Open Anyway**, and confirm
   with your password.

Komposit's icon (a small square) appears in the menu bar and Komposit opens in
your browser. You only do step 4 once.

### Windows (early build)

1. Download **[Komposit-Setup-win.exe](https://github.com/werqaferaw/komposit/releases/latest/download/Komposit-Setup-win.exe)** and run it.
2. Windows SmartScreen says *"Windows protected your PC"*, because this preview
   isn't signed yet. Click **More info**, then **Run anyway**.
3. Click through the installer. It installs for your user only (no administrator
   password) and adds Komposit to the Start menu.

Komposit's icon appears in the system tray, next to the clock (it may be behind
the **^** arrow), and Komposit opens in your browser.

The Windows version is new: it installs and runs, but it hasn't had much time
with real Adobe apps on Windows yet. Please [open an issue](https://github.com/werqaferaw/komposit/issues) for anything that breaks.

## 2. Set up (in the browser)

1. **Choose your AI.**
   - **Claude subscription:** if Claude Code isn't installed yet, the page shows a
     one-line install command (Terminal on a Mac, PowerShell on Windows). Run
     `claude` once to sign in, then click *Check again*.
   - **Key or invite code:** paste it; Komposit checks it before saving. It stays on your computer.
2. **Connect your Adobe apps.** Open the apps you use.
   - **Mac:** click **Allow** for each. macOS asks *"Komposit wants access to control
     Adobe Photoshop"*: click **OK**. Click **Allow** for *Design folders* too, so
     Komposit can list your recent files.
   - **Windows:** there are no permission prompts; click **Test connection** for each app.
3. **Try your first edit.** Open a document, pick an example or type your own
   request, and press Enter.

If you use **Chrome, Edge, Arc or Brave** on the web page, the browser asks
whether the page may connect to apps on this device: click **Allow**.
**Safari** users get the same page served by the Komposit app itself; it works
the same.

## Using it

- **Requests:** say what you want in plain words, like "set the headline in white and center it". Attach or paste a reference image if it helps.
- **Ai / Ps / Ae:** picks the app. Komposit works on that app's active document.
- **Speed:**
  - **Fast** for quick edits.
  - **Balanced** (the default).
  - **Thorough** for hard design decisions. It takes longer.
- **While it works:** you see each step. When it finishes you get the result render and a short note. **Stop** halts it.
- **Point by selecting:** select something in the app and say "make this bigger" or "match these". Komposit reads your selection when you send the message, including a word inside a text box, an item inside a group, or keyframes in After Effects.
- **Exports and saving:** ask for a PNG, a print-ready PDF (Illustrator) or an MP4 (After Effects). Files go to `Komposit Exports` in your home folder and never replace an existing file. "Save" saves your file; "save a copy" makes a new one.
- **Animation:** in After Effects, Komposit can show you a short preview video of the animation right in the chat.
- **Not happy?** Undo in the app (Cmd-Z on a Mac, Ctrl-Z on Windows), or ask Komposit to change it.
- **Chats:** saved on your computer, in the sidebar.

## If something's off

| You see | Do this |
|---|---|
| "Komposit isn't running" | Mac: open Komposit from Applications (look for the menu-bar icon). Windows: open Komposit from the Start menu (look for the tray icon). |
| "not allowed to control …" (Mac) | System Settings > Privacy & Security > Automation > Komposit: turn on the app |
| Claude Code "not signed in" | Run `claude` in Terminal (Mac) or PowerShell (Windows) and sign in, then try again |
| A step says the app "seems to be showing a dialog" | Switch to the app, close the dialog; Komposit carries on |
| After Effects: nothing works | Turn on **Allow Scripts to Write Files and Access Network**: Mac: After Effects > Settings > Scripting & Expressions; Windows: Edit > Preferences > Scripting & Expressions. After a crash, choose **Continue** (Safe Mode turns scripts off). |
| After Effects was just opened | Wait until it has finished starting before sending a request |
| A step keeps failing | Make sure no dialog is open in the Adobe app, then ask again |
| Anything else | Menu-bar or tray icon > **Show Log**, and attach the file to [an issue](https://github.com/werqaferaw/komposit/issues) |

## Removing Komposit

- **Mac:** quit it from the menu-bar icon, delete it from Applications, and
  delete `~/Library/Application Support/Komposit` (settings and chats).
- **Windows:** quit it from the tray icon, then Settings > Apps > Installed apps >
  Komposit > Uninstall. Settings and chats stay in `%APPDATA%\Komposit`; delete
  that folder to remove them too.
