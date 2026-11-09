// Bridge registry. Every app is a module exposing the SAME interface, so the
// harness is written once and each app plugs in:
//
//   label                display name
//   capabilities         { inspect, edit, render, export:[formats], save:[modes], preflight?, selection? }
//   activate()           bring the app forward
//   newDocument(opts)    create a document
//   listDocuments()      [{ name, path, active }]
//   inspect()            { text, image|null }   state map + screenshot
//   selection()          what is selected now; summarizeSelection() puts it in words
//   edit(code)           { ok, result, error, logs }
//   render() / renderNamed(...)   a PNG the agent can SEE
//   exportCopy(opts)     { path }               a COPY, never the source
//   saveDocument(opts)   save, only when the person asks
//   preflight()          print/export checks (Illustrator)
//   undo()               { ok, error }
//
// Supported: Illustrator, Photoshop, After Effects. Premiere Pro has no
// AppleScript or COM scripting path, so it would need a CEP/UXP panel.
// How each platform reaches the apps lives in ../platform/.
import * as illustrator from "./illustrator.mjs";
import * as aftereffects from "./aftereffects.mjs";
import * as photoshop from "./photoshop.mjs";

const BRIDGES = { illustrator, photoshop, aftereffects };

export const APPS = Object.keys(BRIDGES);

export function getBridge(app = "illustrator") {
  const b = BRIDGES[app];
  if (!b) throw new Error(`Unknown app "${app}" — supported: ${APPS.join(", ")}.`);
  return b;
}

export function appManifest() {
  return APPS.map((id) => ({
    id,
    label: BRIDGES[id].label,
    capabilities: BRIDGES[id].capabilities,
    status: BRIDGES[id].status || "live",
  }));
}
