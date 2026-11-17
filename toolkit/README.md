# toolkit

The tools an AI gets for working in creative apps, and the rules around them. It's shared by the Komposit app and the standalone MCP server (`mcp/`). It imports only `protocol/`.

| File | What's in it |
|---|---|
| `tools.ts` | The tool definitions and input schemas (`inspect`, `edit`, `undo`, `render`, `export`, `save`, `preflight`, `dialog`, `place`, `open`, `guide`, and the project tools). The names and inputs match Komposit 1.0, because prompts and recipes depend on them. Also `withTarget` (adds the `app` and `doc` arguments), `supportedAppTools` (which tools a set of connectors can serve) and `checkInput` (checks a call's input against its schema and returns a short reason the AI can act on). |
| `scriptcheck.ts` | `checkScript(code)`: finds code that reaches outside the document: removing, renaming, running, writing or copying files, making folders, saving or exporting to a path (including Photoshop's Action Manager save and export), render-queue renders, menu commands that save, export, revert, close or quit, `system.callSystem` and Photoshop's `app.system`, `app.quit`, closing a document without saving or with no save option, `BridgeTalk`, `doScript` and Photoshop's `doAction` (playing a recorded action), `$.evalFile` and `#include`, `eval`, `new Function` and `scheduleTask`, and `Socket`. Anything inside `Folder.temp` (the scratch folder) is allowed, and comments and string contents are ignored. `findSaves(code)`: finds scripts that save the document. `describeFindings` turns findings into one plain paragraph. Ordinary document work, like `pageItem.remove()`, is left alone. |
| `es3.ts` | `es3Problem(code)`: ExtendScript edit code that can't run (arrow functions, template strings, the ES5 array methods, `Object.keys`, `Array.isArray`), refused before it changes half a document; `scriptSaves(code)`: a plain `.save()` in edit code (saving is the save tool's). |
| `helpers.ts` | Script helpers a chat keeps per app (edit's `helpers` in the Komposit app): `parseHelpers` (function declarations and var lines only, each named), `mergeHelpers` (same name replaces), `withHelpers` (the code with the helpers in front), `mapHelperLine` (an error's line back in the AI's own code, or the helper it's in) and `helpersUsed`. |
| `files.ts` | Path safety and naming. `uniquePath` never reuses a name ("Poster.png", then "Poster 2.png"). `safeBase` makes a name safe to use as a filename. `outputFolder` keeps writes inside the home folder or an allowed folder. `inProject` keeps a path inside a project folder, even through links. Also `isInside`, `expandHome`, `patternRegex`. |
| `labels.ts` | Plain labels for each step: "Looking at the document", "Exported a file", "Bringing logo.png into Photoshop". |
| `dialogs.ts` | `agentMayPress(button)`: an AI may acknowledge or cancel a dialog, but buttons that save, discard, replace or delete are the person's. |

```ts
import { appToolDefs, withTarget, checkInput, checkScript, uniquePath } from "./toolkit/index.ts";

const edit = withTarget(appToolDefs("Cmd", { scripts: "refuse" }).edit!, { appIds: ["illustrator"], multiApp: false });
checkInput(edit.inputSchema, { code: "app.quit()" });   // null: the input is well formed
checkScript("app.quit()");                              // [{ what: "quits the app", snippet: "app.quit()" }]
```

The script check is a seatbelt, not a sandbox. Code built to hide what it does (strings put together, `eval`) can get past a scan. The Komposit app asks the person before running flagged code. The standalone server refuses it.

Tests: `node --test toolkit/toolkit.test.ts`.
