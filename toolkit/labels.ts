// Plain-language labels for what the AI is doing: people read "Looking at the document",
// not tool names. One place, so the live view and the saved history always say the same.
// Ported from 1.0 (labels.mjs). App names come from the connectors (`appLabel`).
// Shared by the Komposit app and the standalone MCP server (apps, documents, new_document
// are the standalone server's own tools).

const RUNNING: Record<string, string> = {
  inspect: "Looking at the document",
  edit: "Making an edit",
  render: "Checking the result",
  export: "Exporting a file",
  save: "Saving",
  preflight: "Checking print readiness",
  listen: "Listening to the audio",
  undo: "Undoing the last change",
  place: "Bringing a file in",
  open: "Opening a file",
  guide: "Reading the app's recipes",
  ask: "Asking you",
  write_file: "Writing a file",
  make_folder: "Making a folder",
  copy: "Copying a file",
  move: "Moving a file",
  trash: "Moving to the Trash",
  preview_file: "Looking at a file",
  find_files: "Looking through the project",
  read_file: "Reading a file",
  apps: "Checking the apps",
  documents: "Listing the open documents",
  new_document: "Making a new document",
};

type Input = Record<string, any>;

function sentence(s: unknown): string {
  const t = String(s || "").replace(/\s+/g, " ").trim().replace(/[.;:]+$/, "");
  if (!t) return "";
  const capped = t.charAt(0).toUpperCase() + t.slice(1);
  return capped.length > 90 ? capped.slice(0, 87).replace(/\s+\S*$/, "") + "…" : capped;
}

export function cleanToolName(name: string): string {
  return String(name || "").replace(/^mcp__komposit__/, "");
}

const tail = (p: unknown) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || "";
const fileOf = (input: Input) => tail(input?.path);
const readsWhat = (input: Input) => {
  const f = tail(input?.file_path || input?.path);
  return f && !/^ref-\d+-\d+\.[a-z]+$/i.test(f) ? `Reading ${f}` : ""; // a pasted reference has a made-up name
};

/** Label while a step runs. An edit's own one-line explanation wins. */
export function stepLabel(name: string, input: Input = {}, appLabel?: string): string {
  const n = cleanToolName(name);
  const into = appLabel ? ` into ${appLabel}` : "";
  const inApp = appLabel ? ` in ${appLabel}` : "";
  if (n === "write_file" && tail(input.path)) return /komposit-notes\.md$/i.test(String(input.path)) ? "Updating the project notes" : `Writing ${tail(input.path)}`;
  if (n === "make_folder" && tail(input.path)) return `Making the folder ${tail(input.path)}`;
  if ((n === "copy" || n === "move") && tail(input.from)) return `${n === "copy" ? "Copying" : "Moving"} ${tail(input.from)}`;
  if (n === "trash") {
    const list = Array.isArray(input.paths) ? input.paths : [];
    return list.length === 1 ? `Moving ${tail(list[0])} to the Trash` : list.length > 1 ? `Moving ${list.length} items to the Trash` : RUNNING.trash!;
  }
  if (n === "read_file" && readsWhat(input)) return readsWhat(input);
  if (n === "save" && input?.mode === "as") return "Saving as a new file";
  if (n === "place" && fileOf(input)) return `Bringing ${fileOf(input)}${into}`;
  if (n === "open" && fileOf(input)) return `Opening ${fileOf(input)}${inApp}`;
  if (n === "edit" && input && input.explanation) return sentence(input.explanation);
  if (n === "dialog") return input?.press ? "Answering the dialog" : "Reading the dialog";
  if (n === "render" && input?.video) return "Rendering a preview video";
  if (n === "render" && Number(input?.frames) > 1) return "Checking the motion";
  if (n === "export" && input?.format === "mp4") return "Rendering the video";
  return RUNNING[n] || "Working";
}

/** Label once it finished, for steps whose outcome changes the wording. */
export function doneLabel(name: string, input: Input = {}, isError = false, appLabel?: string): string {
  const n = cleanToolName(name);
  const into = appLabel ? ` into ${appLabel}` : "";
  const inApp = appLabel ? ` in ${appLabel}` : "";
  if (isError) {
    if (["write_file", "make_folder", "copy", "move", "trash"].includes(n)) return `${stepLabel(n, input)}: not done`;
    if (n === "edit") return "That edit failed, adjusting";
    if (n === "render") return "Could not render a preview";
    if (n === "inspect") return "Could not read the document";
    if (n === "export") return "The export didn't work";
    if (n === "save") return "Couldn't save";
    if (n === "place") return `Couldn't bring ${fileOf(input) || "the file"} in`;
    if (n === "open") return `Couldn't open ${fileOf(input) || "the file"}`;
    if (n === "new_document") return "Couldn't make a new document";
    return "That step failed";
  }
  if (n === "place" && fileOf(input)) return `Brought ${fileOf(input)}${into}`;
  if (n === "open" && fileOf(input)) return `Opened ${fileOf(input)}${inApp}`;
  if (n === "inspect") return "Looked at the document";
  if (n === "render" && input?.video) return "Rendered a preview video";
  if (n === "render" && Number(input?.frames) > 1) return "Checked the motion";
  if (n === "render") return "Checked the result";
  if (n === "export") return "Exported a file";
  if (n === "save") return input && input.mode === "copy" ? "Saved a copy" : input && input.mode === "as" ? "Saved as a new file" : "Saved the document";
  if (n === "write_file") return /komposit-notes\.md$/i.test(String(input?.path || "")) ? "Updated the project notes" : `Wrote ${tail(input?.path) || "a file"}`;
  if (n === "make_folder") return `Made the folder ${tail(input?.path)}`;
  if (n === "copy") return `Copied ${tail(input?.from)}`;
  if (n === "move") return `Moved ${tail(input?.from)}`;
  if (n === "trash") {
    const list = Array.isArray(input?.paths) ? input.paths : [];
    return list.length === 1 ? `Moved ${tail(list[0])} to the Trash` : `Moved ${list.length} items to the Trash`;
  }
  if (n === "find_files") return "Looked through the project";
  if (n === "read_file" && readsWhat(input)) return readsWhat(input).replace(/^Reading/, "Read");
  if (n === "preflight") return "Checked print readiness";
  if (n === "listen") return "Listened to the audio";
  if (n === "undo") return "Undid the last change";
  if (n === "guide") return "Read the app's recipes";
  if (n === "apps") return "Checked the apps";
  if (n === "documents") return "Listed the open documents";
  if (n === "new_document") return "Made a new document";
  if (n === "ask") return "You answered";
  if (n === "dialog") return input && input.press ? `Answered the dialog (${String(input.press).slice(0, 30)})` : "Read the dialog";
  return stepLabel(n, input, appLabel);
}
