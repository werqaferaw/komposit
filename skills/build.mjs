#!/usr/bin/env node
// Makes one skill per app from its connector: skills/<app>/SKILL.md, with the app's recipes
// copied verbatim from connectors/<app>/guide.md (the same text the guide tool serves).
//   node skills/build.mjs           write the skills
//   node skills/build.mjs --check   fail if any skill is out of date (tests run this)
// Edit the guide, never SKILL.md's recipes: this script overwrites them.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// What each app is for, in the words people use when they ask. New connectors get a plain default.
const FOR = {
  illustrator: "vector artwork, logos, icons, illustrations, layouts and print-ready files",
  photoshop: "photos, retouching, compositing, social graphics and layered images",
  aftereffects: "motion graphics, animation, compositions and video renders",
  premiere: "video editing, cuts, sequences, titles, sound levels and video exports",
};

// Rules that only hold for one app, after the shared ones.
const NOTES = {
  premiere: [
    "- Premiere Pro's scripts only reach its active project: pass `doc` (the project's name and path from `documents`) on every call that changes it (`edit`, `undo`, `save`, `place`, and `render` with `video`). A call for a project that isn't the active one, or one that names none, changes nothing and says why; then ask the person to click into the right project.",
    "- Komposit reaches Premiere Pro through its own small panel inside the app. When `apps` says the panel isn't installed or hasn't loaded, pass on what it says.",
    "- To check a cut, `render` with `frames` 2-8. To find or rule something out across a stretch, watch it: `render` with `every` (seconds between frames), `from` and `to` gives contact sheets.",
    "- Before cutting to music or speech, `listen`: the sequence's sound (who talks when, the pauses, the words when Premiere has transcribed them; a song's tempo, every beat, its bars, sections and strongest hits) in sequence seconds, or one file's with `path`. The next `edit` gets it as `K.heard`, and `K.cutOnBeats`, `K.beats` and `K.markBeats` use it: see cut-to-the-beat and find-the-story below.",
  ],
  aftereffects: [
    "- Before timing anything to sound, `listen`: the comp's layers with sound (a voice's lines and pauses; a song's tempo, every beat, its bars, sections and strongest hits) in comp seconds, or one file's with `path`. The next `edit` gets it as `K.heard`, with `K.beats`, `K.markBeats` and `K.onBeats`: see timing-to-sound below.",
  ],
};

const MARK = "<!-- The recipes below are generated from connectors/{app}/guide.md by skills/build.mjs. Edit the guide, then run node skills/build.mjs. -->";

/** The apps with a guide, by id. */
export function guideApps() {
  const dir = join(root, "connectors");
  return readdirSync(dir).filter((n) => existsSync(join(dir, n, "guide.md")) && existsSync(join(dir, n, "index.ts"))).sort();
}

const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0] || "");

/** SKILL.md for one app: frontmatter, how to work through the komposit tools, the recipes. */
export function renderSkill(app, manifest, guide) {
  const L = manifest.label;
  const c = manifest.capabilities;
  const lang = manifest.language === "extendscript" ? "ExtendScript (ES3: `var` and `function`; no `let`, `const`, arrow functions or template strings)" : manifest.language;
  const what = FOR[app] || "work in its documents";
  const description =
    `Use when the person wants something made, changed, checked or exported in ${L} (${what}) and the komposit MCP tools are available. ` +
    `Covers how to look, script with ${manifest.language === "extendscript" ? "ExtendScript" : manifest.language}, render, export and save safely, plus tested ${L} recipes.`;
  const saveModes = { overwrite: "`overwrite` (the file itself)", copy: "`copy` (a new file, the document stays as it is)", as: "`as` (a new file the document becomes)" };
  const lines = [
    "---",
    `name: ${app}`,
    `description: ${description}`,
    "---",
    "",
    `# ${L} through Komposit`,
    "",
    `Work in the person's open ${L} documents with the komposit MCP tools (the komposit-mcp server). Pass \`app: "${app}"\` on every app tool, and \`doc\` ({ name, path } from \`documents\`) when more than one document is open.`,
    "",
    "## How to work",
    "",
    `1. Look first. \`apps\` says whether ${L} is open and ready; \`documents\` lists what's open; \`inspect\` maps the document (each item has a \`ref\` you can use in code) and shows a picture.`,
    `2. Find the recipe. The recipes below are the same ones \`guide\` serves (\`guide\` with no topic lists them). Build on them instead of guessing the scripting API.`,
    `3. Change with \`edit\`: ${lang}. \`return\` what you need to check, and batch related changes in one script. A failure comes back with its line number.`,
    `4. Look at the result. \`render\` after a visual change${c.singleDocument ? " (`frames` 2-8 to check motion; `video: true` for a short preview)" : ""}; fix what's off, or \`undo\`.`,
    `5. Check before you say it's done: what was asked is there and nothing else moved.${c.preflight ? " For print, run `preflight`." : ""}`,
    `6. Deliver. \`export\` writes a new file (${list(c.export)}) to ~/Komposit Exports or an \`outputDir\` in the home folder, and never overwrites. \`save\` only when the person asks: ${list(c.save.map((m) => saveModes[m] || `\`${m}\``))}.`,
    "",
    "## Rules",
    "",
    "- Never save unless the person asks. Edits stay in the app's undo history until they do.",
    "- Scripts that delete, rename or run files, run commands, quit the app, close documents or save are refused. Use the tools, or leave it to the person.",
    `- Komposit never opens ${L}. If it isn't open, ask the person to open it.`,
    `- ${L} takes one call at a time; calls wait their turn.`,
    ...(c.place ? [`- To bring in a file from elsewhere (another app's export, an image), use \`place\` with its absolute path.`] : []),
    ...(c.singleDocument ? [`- ${L} keeps one project open: bring files in with \`place\`, and use \`new_document\` for a new composition.`] : []),
    ...(NOTES[app] || []),
    "",
    MARK.replace("{app}", app),
    "",
    "",
  ];
  return lines.join("\n") + guide;
}

export async function buildSkills({ check = false } = {}) {
  const stale = [];
  const written = [];
  for (const app of guideApps()) {
    const { manifest } = await import(pathToFileURL(join(root, "connectors", app, "index.ts")).href);
    const guide = readFileSync(join(root, "connectors", app, "guide.md"), "utf8");
    const out = join(here, app, "SKILL.md");
    const want = renderSkill(app, manifest, guide);
    const have = existsSync(out) ? readFileSync(out, "utf8") : null;
    if (have === want) continue;
    if (check) stale.push(`skills/${app}/SKILL.md`);
    else {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, want);
      written.push(`skills/${app}/SKILL.md`);
    }
  }
  return { stale, written };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  buildSkills({ check }).then(
    ({ stale, written }) => {
      if (stale.length) {
        console.error(`Out of date (run node skills/build.mjs): ${stale.join(", ")}`);
        process.exit(1);
      }
      console.log(check ? "Skills are in sync with the guides." : written.length ? `Wrote ${written.join(", ")}` : "Skills already up to date.");
    },
    (e) => {
      console.error(e?.message || e);
      process.exit(1);
    },
  );
}
