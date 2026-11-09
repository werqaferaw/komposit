// Plain-language labels for what the agent is doing. Both engines report raw
// tool names (inspect, edit, mcp__komposit__render); people should read
// "Looking at the document", not tool names. One place, so the live view and
// the saved history always say the same thing.

const RUNNING = {
  inspect: "Looking at the document",
  edit: "Making an edit",
  render: "Checking the result",
  export: "Exporting a file",
  save: "Saving",
  preflight: "Checking print readiness",
  undo: "Undoing the last change",
  Read: "Looking at your reference",
};

function sentence(s) {
  const t = String(s || "").replace(/\s+/g, " ").trim().replace(/[.;:]+$/, "");
  if (!t) return "";
  const capped = t.charAt(0).toUpperCase() + t.slice(1);
  return capped.length > 90 ? capped.slice(0, 87).replace(/\s+\S*$/, "") + "…" : capped;
}

export function cleanToolName(name) {
  return String(name || "").replace(/^mcp__komposit__/, "");
}

// Label while a step runs. An edit's own one-line explanation wins.
export function stepLabel(name, input = {}) {
  const n = cleanToolName(name);
  if (n === "edit" && input && input.explanation) return sentence(input.explanation);
  if (n === "render" && input?.video) return "Rendering a preview video";
  if (n === "render" && Number(input?.frames) > 1) return "Checking the motion";
  if (n === "export" && input?.format === "mp4") return "Rendering the video";
  return RUNNING[n] || "Working";
}

// Label once it finished, for steps whose outcome changes the wording.
export function doneLabel(name, input = {}, { isError = false } = {}) {
  const n = cleanToolName(name);
  if (isError) {
    if (n === "edit") return "That edit failed, adjusting";
    if (n === "render") return "Could not render a preview";
    if (n === "inspect") return "Could not read the document";
    if (n === "export") return "The export didn't work";
    if (n === "save") return "Couldn't save";
    return "That step failed";
  }
  if (n === "inspect") return "Looked at the document";
  if (n === "render" && input?.video) return "Rendered a preview video";
  if (n === "render" && Number(input?.frames) > 1) return "Checked the motion";
  if (n === "render") return "Checked the result";
  if (n === "export") return "Exported a file";
  if (n === "save") return input && input.mode === "copy" ? "Saved a copy" : "Saved the document";
  if (n === "preflight") return "Checked print readiness";
  if (n === "undo") return "Undid the last change";
  if (n === "Read") return "Looked at your reference";
  return stepLabel(n, input);
}
