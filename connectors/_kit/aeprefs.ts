// After Effects' "Allow Scripts to Write Files and Access Network" (off by default). Every
// After Effects script hands its result back through a file, so with it off nothing comes
// back. Read from the prefs file, same format on both systems:
//   Mac      ~/Library/Preferences/Adobe/After Effects/<ver>/Adobe After Effects <ver> Prefs.txt
//   Windows  %APPDATA%\Adobe\After Effects\<ver>\Adobe After Effects <ver> Prefs.txt
// Key in ["Main Pref Section v2"]:  "Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "1"
// (The Mac file uses CR line endings, so the match doesn't depend on lines.)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export function parseAePref(text: string, key = "Pref_SCRIPTING_FILE_NETWORK_SECURITY"): boolean | null {
  const m = new RegExp(`"${key}"\\s*=\\s*"?(\\d)"?`).exec(String(text));
  return m ? m[1] === "1" : null;
}

/** The newest "Adobe After Effects <ver> Prefs.txt" under `base`: true, false or null. */
export function aeScriptWritesPref(base: string): boolean | null {
  try {
    const files = readdirSync(base)
      .map((v) => join(base, v, `Adobe After Effects ${v} Prefs.txt`))
      .filter((f) => existsSync(f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files.length ? parseAePref(readFileSync(files[0], "latin1")) : null;
  } catch {
    return null;
  }
}
