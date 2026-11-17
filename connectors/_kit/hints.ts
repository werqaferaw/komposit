// One plain, actionable hint after the common script errors, so the AI's next try is the right
// one instead of a guess. From a day of real work (Nov 16): 26 script errors, each a round trip,
// most of them one of the messages below. The app's own message always stays first; the hint
// follows it ("Hint: ..."). Only for errors inside a script, never for the app being away.

interface Rule {
  /** Which apps the rule is for; none = every ExtendScript app. */
  apps?: string[];
  re: RegExp;
  hint: string;
}

const ES3 =
  "ExtendScript is ES3: arrays have no map, forEach, filter, reduce, some, every or indexOf, strings have no trim, and there's no Object.keys or Array.isArray. Use for loops (for (var i = 0; i < a.length; i++)) and plain functions.";

const RULES: Rule[] = [
  {
    apps: ["illustrator"],
    re: /Target layer cannot be modified/i,
    hint:
      "the layer being drawn into or changed, or a layer it sits in, is locked or hidden (new items also go to doc.activeLayer, so that one counts too). " +
      "Unlock and show it and its parent layers for the change and put them back as they were afterwards, or work on a visible, unlocked layer and set doc.activeLayer to it first. Check with inspect (layers show visible and locked).",
  },
  {
    apps: ["illustrator"],
    re: /1346458189|'MRAP'/,
    hint:
      "this is Illustrator's PARM error: it rejected a value on that line. Usually a number that is NaN, undefined or out of range, a value of the wrong kind, " +
      "or a call the item can't take (moving or duplicating into a locked or hidden layer, removing the last artboard). Log the values used on that line and check them.",
  },
  {
    apps: ["illustrator"],
    re: /1112237433|'yeKB'/,
    hint: "a menu command (app.executeMenuCommand) that can't run in the current state, such as exitisolation when nothing is in isolation mode. Wrap menu commands in try/catch, or leave this one out.",
  },
  {
    re: /No such element/i,
    hint:
      "nothing has that name: getByName and lookups by name throw when it's missing (names are exact and case-sensitive). Loop over the collection and compare .name instead, " +
      "and handle not finding it; inspect lists the names that are there.",
  },
  {
    re: /Object is invalid/i,
    hint:
      "the script used a reference to an item that no longer exists or was replaced (removed, ungrouped, expanded, outlined, or moved to another document). Look the item up again after a change instead of reusing the old variable.",
  },
  {
    apps: ["illustrator"],
    re: /requested property is not available for this type of text frame/i,
    hint:
      "text frames come in three kinds (tf.kind): TextType.POINTTEXT, AREATEXT and PATHTEXT, and some properties only exist on some kinds (anchor is point text only; columns, rows and insets are area text only). Check tf.kind before reading or setting them.",
  },
  {
    re: /Not implemented/i,
    hint: "this object doesn't support that property or method (often one that belongs to another kind of item, such as anchor on area text). Check the item's typename (and kind, for text) first, or do it another way.",
  },
  {
    re: /Illegal Argument|Illegal argument/,
    hint: "a value passed on that line is of the wrong kind: a number where an object is wanted, an array of the wrong length, or a color that doesn't match the document's color mode (RGBColor in a CMYK document). Log it and check.",
  },
  {
    re: /Required value is missing/i,
    hint: "a call on that line got undefined for something it needs, often a lookup that found nothing (a font from app.textFonts.getByName that isn't installed, a missing swatch). Check each value before using it.",
  },
  {
    re: /operation was cancell?ed/i,
    hint: "the app cancelled it, which is what a save, close or export from inside a script does when it would need a dialog. Don't save from a script: use the save and export tools.",
  },
  {
    apps: ["photoshop"],
    re: /\brevert is not a function/i,
    hint:
      "Photoshop's scripting has no doc.revert(). To step back, set doc.activeHistoryState to an earlier entry of doc.historyStates; to go back to the saved file, run executeAction(charIDToTypeID('Rvrt'), undefined, DialogModes.NO).",
  },
  {
    re: /\b(map|forEach|filter|reduce|some|every|indexOf|trim|keys|isArray|includes|find) is not a function/i,
    hint: ES3,
  },
  {
    apps: ["illustrator", "photoshop"],
    re: /is not open in (Illustrator|Photoshop) anymore/i,
    hint: "that document was closed, or saved under another name. Calls with no doc stay on the request's document, so don't carry on in another file on your own: tell the user it was closed, and if they want you to work in another document, name it as doc.",
  },
  {
    apps: ["aftereffects"],
    re: /isn't (open in After Effects|in the project) anymore/i,
    hint: "the project was closed or another one opened, or the comp was deleted or renamed. Calls with no doc stay on the request's comp, so don't carry on somewhere else on your own: tell the user, and if they want you to work in another comp, name it as doc part.",
  },
];

/** The hint for a script error, or null when there isn't one. `app` is the connector's id. */
export function scriptHint(app: string, message: string | null | undefined): string | null {
  const m = String(message || "");
  if (!m || /\bHint: /.test(m)) return null;
  for (const r of RULES) {
    if (r.apps && !r.apps.includes(app)) continue;
    if (r.re.test(m)) return r.hint.charAt(0).toUpperCase() + r.hint.slice(1);
  }
  return null;
}

/** The error with its hint after it, when there is one. */
export function withHint(app: string, message: string): string {
  const h = scriptHint(app, message);
  if (!h) return message;
  return `${message.replace(/\s+$/, "")}${/[.!?]$/.test(message.trim()) ? "" : "."} Hint: ${h}`;
}
