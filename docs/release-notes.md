Komposit is a design agent that works in your open Illustrator, Photoshop and After Effects documents. You say what you want; it makes the change in the live file, renders the result to check its work, and tells you what it did. Every change stays in the app's undo history.

## Downloads

| | File | Needs |
|---|---|---|
| **Mac** | `Komposit-mac.dmg` | macOS 13.5 or later, Apple silicon or Intel |
| **Windows (early build)** | `Komposit-Setup-win.exe` | Windows 10 or 11, 64-bit |

Both need Illustrator, Photoshop or After Effects, and one of: a Claude Pro or Max plan (through Claude Code), an Anthropic API key, an OpenRouter key, or an invite code.

## First launch

**Mac.** Open the DMG and drag Komposit to Applications. The first time you open it, macOS says it can't check it for malicious software (this preview isn't signed with an Apple certificate): click Done, then open System Settings > Privacy & Security, click **Open Anyway** next to "Komposit was blocked", and confirm. Komposit appears in the menu bar and opens in your browser.

**Windows.** Run `Komposit-Setup-win.exe`. Windows SmartScreen says "Windows protected your PC" because the installer isn't signed yet: click **More info**, then **Run anyway**. It installs for your user only (no admin rights) and adds Komposit to the Start menu. Komposit appears in the system tray, next to the clock, and opens in your browser.

## What's in this preview

- Edits in the live document of Illustrator, Photoshop and After Effects, in plain language.
- Reads what you have selected when you send a message: "make this blue" means the thing you selected.
- Renders its work to check it, and shows you the result.
- Exports PNG, JPG, SVG and print-ready PDF (Illustrator), PNG and JPG (Photoshop), frames and MP4 (After Effects), into `Komposit Exports` in your home folder. It never overwrites a file.
- After Effects: a short preview video of the animation, right in the chat.
- Attach any file (images, PDFs, logos, briefs) or talk instead of typing.
- Your chats and settings stay on your computer.

## Known limits

- **Windows is an early build.** It has been built and tested automatically, but not yet on a PC with Illustrator, Photoshop and After Effects installed. Expect rough edges, and please tell us what breaks.
- After Effects needs **Allow Scripts to Write Files and Access Network** turned on (Mac: After Effects > Settings > Scripting & Expressions; Windows: Edit > Preferences > Scripting & Expressions).
- While an Adobe app shows a dialog, it won't run scripts. Close the dialog and Komposit carries on.
- Premiere Pro isn't supported yet.

Problems and questions: [open an issue](https://github.com/werqaferaw/komposit/issues) and attach the log (menu-bar or tray icon > Show Log).
