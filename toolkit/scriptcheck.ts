// The script check: before edit code reaches an app, look for things that reach outside the
// document and ask the person first (the Komposit app) or refuse (the standalone MCP server).
// Tricks (strings put together, eval) can get past a scan, so this is a seatbelt; approvals are
// the brake. Code built at run time is itself flagged, so the obvious tricks are caught too.
//
// Careful with false alarms: `item.remove()` is how ExtendScript deletes a page item or a
// layer (Illustrator recipes use it all the time), so only File and Folder objects count;
// `$.writeln()` is logging, not writing a file; `app.copy()` is the clipboard. Comments and the
// insides of strings are ignored, so "// never call saveAs here" or alert("eval") pass.
//
// The scratch folder (`Folder.temp`, the system's temporary folder, where Komposit's own
// scratch files live too) is fair game: making a folder or writing a file there is not flagged.

export interface ScriptFinding {
  /** Plain description for the person: "deletes a file". */
  what: string;
  /** The bit of code, trimmed. */
  snippet: string;
}

/** The plain reasons, one per kind of finding. */
export const SCRIPT_REASONS = {
  remove: "deletes a file or folder on your computer",
  execute: "opens or runs a file on your computer",
  rename: "renames a file on your computer",
  callSystem: "runs a command on your computer (After Effects system.callSystem)",
  appSystem: "runs a command on your computer (Photoshop app.system)",
  quit: "quits the app",
  closeNoSave: "closes a document without saving it",
  close: "closes a document",
  write: "writes a file on your computer",
  copy: "copies a file to another place on your computer",
  mkdir: "makes a folder on your computer",
  saveTo: "saves or exports to a file on your computer",
  render: "renders the render queue to files on your computer",
  menu: "uses a menu command that saves, exports, reverts, closes or quits",
  bridgeTalk: "sends code to another app (BridgeTalk)",
  doScript: "plays an action or runs another script (doScript), which can do anything the app can",
  doAction: "plays a recorded action (doAction), which can do anything the app can, saving and closing included",
  evalFile: "runs code from a file on your computer",
  built: "runs code it puts together while running, so what that code does can't be checked first",
  network: "connects to another computer over the network",
} as const;

const snip = (code: string, index: number, length: number) => {
  const start = code.lastIndexOf("\n", index) + 1;
  let end = code.indexOf("\n", index + length);
  if (end === -1) end = code.length;
  const line = code.slice(start, end).trim();
  return line.length > 120 ? line.slice(0, 117) + "..." : line;
};

// Characters after which a `/` starts a regular expression rather than a division.
// ...and words after which it does too (`return /x/.test(s)`).
const KEYWORD_BEFORE = /(?:^|[^\w$.])(?:return|typeof|case|delete|void|throw|in|instanceof|new|do|else)\s*$/;
const REGEX_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

/** Two copies of the code, the same length as the original (so indexes line up): `code` with
 *  comments blanked out, and `bare` with comments and the insides of strings and regular
 *  expressions blanked out too. Strings end at a line break, so one odd line can't hide the rest. */
export function maskScript(src: string): { code: string; bare: string } {
  const code = src.split("");
  const bare = src.split("");
  const n = src.length;
  const blank = (arr: string[], a: number, b: number) => { for (let k = a; k < b && k < n; k++) if (arr[k] !== "\n") arr[k] = " "; };
  let prev = "";
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      let j = src.indexOf("\n", i);
      if (j === -1) j = n;
      blank(code, i, j); blank(bare, i, j);
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      let j = src.indexOf("*/", i + 2);
      j = j === -1 ? n : j + 2;
      blank(code, i, j); blank(bare, i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || (c === "/" && (REGEX_AFTER.has(prev) || KEYWORD_BEFORE.test(src.slice(Math.max(0, i - 12), i))))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        const e = src[j];
        if (e === "\\") { j += 2; continue; }
        if (c === "/") {
          if (e === "[") inClass = true;
          else if (e === "]") inClass = false;
          else if (e === "/" && !inClass) break;
        } else if (e === c) break;
        j++;
      }
      blank(bare, i + 1, j);
      prev = "a"; // a value: a `/` after it divides
      i = j < n && src[j] !== "\n" ? j + 1 : j;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { code: code.join(""), bare: bare.join("") };
}

const ID = "[A-Za-z_$][\\w$]*";
const esc = (s: string) => s.replace(/[$]/g, "\\$");
const TEMP = /\bFolder\s*\.\s*temp\b/;

/** The text inside the parentheses that open at `open` (an index of "(" in `bare`), as [from, to). */
function parenRange(bare: string, open: number): [number, number] {
  let depth = 0;
  for (let k = open; k < bare.length; k++) {
    if (bare[k] === "(") depth++;
    else if (bare[k] === ")" && --depth === 0) return [open + 1, k];
  }
  return [open + 1, bare.length];
}

export function checkScript(code: string): ScriptFinding[] {
  const src = String(code || "");
  const { code: text, bare } = maskScript(src);
  const found: ScriptFinding[] = [];
  const add = (what: string, index: number, length: number) => {
    if (!found.some((f) => f.what === what)) found.push({ what, snippet: snip(src, index, length) });
  };
  const each = (re: RegExp, on: string, fn: (m: RegExpExecArray) => void) => {
    for (const m of on.matchAll(re)) fn(m as RegExpExecArray);
  };
  // A match on `text` (strings kept) only counts where it isn't itself inside a string.
  const inCode = (i: number) => bare[i] === text[i];

  // Names bound to a File or Folder: `var f = new File(p)`, `f = Folder("~/x")`, `File.openDialog()`...
  const fileVars = new Set<string>();
  each(new RegExp(`\\b(${ID})\\s*=\\s*(?:new\\s+)?(?:File|Folder)\\s*[.(]`, "g"), bare, (m) => fileVars.add(m[1]!));
  // `for (...) { var f = files[i] }` from Folder.getFiles(): treat getFiles() results as files too.
  each(new RegExp(`\\b(${ID})\\s*=\\s*[^;\\n]*\\.getFiles\\s*\\(`, "g"), bare, (m) => fileVars.add(m[1]!));

  // Names that only ever point into the scratch folder: every assignment mentions Folder.temp
  // or another scratch name, and none climbs out with "..".
  const assigned = new Map<string, { bare: string; code: string }[]>();
  each(new RegExp(`\\b(${ID})\\s*=(?!=)\\s*([^;\\n]*)`, "g"), bare, (m) => {
    const from = m.index + m[0].length - m[2]!.length;
    const list = assigned.get(m[1]!) || [];
    list.push({ bare: m[2]!, code: text.slice(from, from + m[2]!.length) });
    assigned.set(m[1]!, list);
  });
  const scratch = new Set<string>();
  const pointsToScratch = (b: string, c: string) => {
    if (c.includes("..")) return false;
    if (TEMP.test(b)) return true;
    const first = new RegExp(`^\\s*(?:new\\s+)?(?:(?:File|Folder)\\s*\\(\\s*)?(${ID})`).exec(b);
    return !!first && scratch.has(first[1]!);
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, list] of assigned) {
      if (!scratch.has(name) && list.every((a) => pointsToScratch(a.bare, a.code))) { scratch.add(name); grew = true; }
    }
  }
  /** Is the thing a method is called on (the statement up to `at`) in the scratch folder? */
  const receiverInScratch = (at: number) => {
    let start = at;
    while (start > 0 && !";{}\n".includes(bare[start - 1]!)) start--;
    const b = bare.slice(start, at);
    const c = text.slice(start, at);
    if (c.includes("..")) return false;
    if (TEMP.test(b)) return true;
    const last = new RegExp(`(${ID})(?:\\s*\\[[^\\]]*\\])?\\s*$`).exec(b);
    return !!last && scratch.has(last[1]!);
  };

  const fileRef = (method: string) => {
    const direct = new RegExp(`\\b(?:File|Folder)\\s*\\([^)]*\\)\\s*\\.\\s*${method}\\s*\\(`, "g");
    const viaVar = fileVars.size ? new RegExp(`\\b(?:${[...fileVars].map(esc).join("|")})(?:\\s*\\[[^\\]]*\\])?\\s*\\.\\s*${method}\\s*\\(`, "g") : null;
    const viaList = new RegExp(`\\.getFiles\\s*\\([^)]*\\)\\s*\\[[^\\]]*\\]\\s*\\.\\s*${method}\\s*\\(`, "g");
    return [direct, viaList, ...(viaVar ? [viaVar] : [])];
  };
  // Index of the "." before the method in a fileRef match.
  const dotOf = (m: RegExpExecArray, method: string) => m.index + m[0].search(new RegExp(`\\.\\s*${method}\\s*\\($`));

  // Deleting, running, renaming files.
  for (const re of fileRef("remove")) each(re, bare, (m) => add(SCRIPT_REASONS.remove, m.index, m[0].length));
  for (const re of fileRef("execute")) each(re, bare, (m) => add(SCRIPT_REASONS.execute, m.index, m[0].length));
  for (const re of fileRef("rename")) each(re, bare, (m) => add(SCRIPT_REASONS.rename, m.index, m[0].length));

  // Writing files: opened for writing ("w"), appending ("a") or editing ("e"), or written to.
  each(/\.\s*open\s*\(\s*["'][wae]["']/g, text, (m) => {
    if (inCode(m.index) && !receiverInScratch(m.index)) add(SCRIPT_REASONS.write, m.index, m[0].length);
  });
  if (fileVars.size) {
    each(new RegExp(`\\b(?:${[...fileVars].map(esc).join("|")})(?:\\s*\\[[^\\]]*\\])?\\s*\\.\\s*write(?:ln)?\\s*\\(`, "g"), bare, (m) => {
      if (!receiverInScratch(dotOf(m, "write(?:ln)?"))) add(SCRIPT_REASONS.write, m.index, m[0].length);
    });
  }
  // Copying a file somewhere (into the scratch folder is fine).
  for (const re of fileRef("copy")) each(re, bare, (m) => {
    const [a, b] = parenRange(bare, m.index + m[0].length - 1);
    if (!pointsToScratch(bare.slice(a, b), text.slice(a, b))) add(SCRIPT_REASONS.copy, m.index, m[0].length);
  });
  // Making a folder outside the scratch folder.
  for (const re of fileRef("create")) each(re, bare, (m) => {
    if (!receiverInScratch(dotOf(m, "create"))) add(SCRIPT_REASONS.mkdir, m.index, m[0].length);
  });

  // Saving or exporting to a path the code names (plain .save() in place is findSaves' business).
  each(/\.\s*(?:saveAs|saveACopy|saveAsCopy|exportFile|exportDocument|exportForScreens|imageCapture|exportPDFPresetFile|exportPresetFile|exportVariables|saveFrameToPng|exportAsMotionGraphicsTemplate)\s*\(/g, bare, (m) => add(SCRIPT_REASONS.saveTo, m.index, m[0].length));
  // Premiere Pro's: a video, a frame, a sequence as a project, timelines for other apps, Media Encoder.
  each(/\.\s*(?:exportAsMediaDirect|exportFramePNG|exportFrameJPEG|exportAsProject|exportFinalCutProXML|exportAsFinalCutProXML|exportAAF|exportOMF|encodeSequence|encodeProjectItem|encodeFile)\s*\(/g, bare, (m) => add(SCRIPT_REASONS.saveTo, m.index, m[0].length));
  each(/\.\s*save\s*\(\s*[^)\s]/g, bare, (m) => add(SCRIPT_REASONS.saveTo, m.index, m[0].length));
  // Photoshop's Action Manager: executeAction(charIDToTypeID("save") or "Expr"...).
  each(/\b(?:charIDToTypeID|stringIDToTypeID|cTID|sTID|c2t|s2t)\s*\(\s*["'](?:save|Expr|export)["']\s*\)/g, text, (m) => {
    if (inCode(m.index)) add(SCRIPT_REASONS.saveTo, m.index, m[0].length);
  });
  each(/\brenderQueue\s*\.\s*(?:render|queueInAME)\s*\(/g, bare, (m) => add(SCRIPT_REASONS.render, m.index, m[0].length));
  each(/\bexecuteMenuCommand\s*\(\s*["'](?:save\w*|export\w*|revert\w*|close\w*|quit)["']/gi, text, (m) => {
    if (inCode(m.index)) add(SCRIPT_REASONS.menu, m.index, m[0].length);
  });

  // Commands, quitting, closing.
  each(/\bsystem\s*\.\s*callSystem\s*\(/g, bare, (m) => add(SCRIPT_REASONS.callSystem, m.index, m[0].length));
  each(/\bapp\s*\.\s*system\s*\(/g, bare, (m) => add(SCRIPT_REASONS.appSystem, m.index, m[0].length));
  each(/\bapp\s*\.\s*(?:quit|exit)\s*\(/g, bare, (m) => add(SCRIPT_REASONS.quit, m.index, m[0].length));
  each(/\b(?:DONOTSAVECHANGES|DO_NOT_SAVE_CHANGES)\b/g, bare, (m) => add(SCRIPT_REASONS.closeNoSave, m.index, m[0].length));
  // close() on a document or project with no save option: what it does depends on the app,
  // and in quiet mode it may throw the changes away. (A File called docFile closing is fine.)
  each(/\b(activeDocument|documents\s*\[[^\]]*\]|project|doc\w*)\s*\.\s*close(?:Document)?\s*\(\s*\)/g, bare, (m) => {
    if (!fileVars.has(m[1]!)) add(SCRIPT_REASONS.close, m.index, m[0].length);
  });

  // Other apps, other scripts, code built at run time, the network.
  each(/\bBridgeTalk\b/g, bare, (m) => add(SCRIPT_REASONS.bridgeTalk, m.index, m[0].length));
  each(/\.\s*doScript\s*\(/g, bare, (m) => add(SCRIPT_REASONS.doScript, m.index, m[0].length));
  // Photoshop plays a recorded action with app.doAction: whatever was recorded runs.
  each(/\.\s*doAction\s*\(/g, bare, (m) => add(SCRIPT_REASONS.doAction, m.index, m[0].length));
  each(/\$\s*\.\s*evalFile\s*\(/g, bare, (m) => add(SCRIPT_REASONS.evalFile, m.index, m[0].length));
  // ExtendScript's include directives (#include, //@include) load another file's code.
  each(/^[ \t]*(?:#|\/\/\s*@)include(?:path)?\b/gm, src, (m) => add(SCRIPT_REASONS.evalFile, m.index, m[0].length));
  each(/(?<![\w$])eval\s*\(|\bnew\s+Function\s*\(|(?<![\w$.])Function\s*\(|\bscheduleTask\s*\(/g, bare, (m) => add(SCRIPT_REASONS.built, m.index, m[0].length));
  each(/\bnew\s+Socket\b/g, bare, (m) => add(SCRIPT_REASONS.network, m.index, m[0].length));
  return found;
}

/** Code that saves the document from inside a script. Saving is the person's call: it goes
 *  through the save tool, so a script never writes over their file behind their back. Kept
 *  apart from checkScript, which the Komposit app uses for its approval cards. */
export function findSaves(code: string): ScriptFinding[] {
  const src = String(code || "");
  const { bare } = maskScript(src);
  const found: ScriptFinding[] = [];
  // .save(), .saveAs()... and closing with a save option (SaveOptions.SAVECHANGES,
  // CloseOptions.SAVE_CHANGES; the DONOTSAVE forms don't match, checkScript covers those).
  const re = /\.\s*(?:save|saveAs|saveACopy|saveAsCopy|saveWithDialog)\s*\(|\b(?:SAVECHANGES|SAVE_CHANGES)\b/g;
  for (const m of bare.matchAll(re)) {
    found.push({ what: "saves the document", snippet: snip(src, m.index ?? 0, m[0].length) });
    break;
  }
  return found;
}

/** One plain paragraph for the approval card. */
export function describeFindings(found: ScriptFinding[], appLabel: string): string {
  const list = found.map((f) => `${f.what}: ${f.snippet}`).join("\n");
  return `This edit in ${appLabel} reaches outside the document. It ${found.map((f) => f.what).join(", and ")}.\n${list}`;
}
