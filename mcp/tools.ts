// The standalone server's tool list: the toolkit's app tools (1.0's names and inputs) plus
// three of its own (apps, documents, new_document). Fixed for the life of the process, in
// this order, so an AI's cached prefix stays valid.
import type { Connector } from "../protocol/connector.ts";
import type { ToolDef } from "../protocol/tools.ts";
import { appToolDefs, supportedAppTools, withTarget } from "../toolkit/tools.ts";

export const MCP_TOOL_ORDER = [
  "apps", "documents", "inspect", "edit", "render", "listen", "export", "save", "undo", "preflight", "place", "open", "new_document", "guide",
] as const;

/** Tools that change a document or write a file (everything else only reads). */
export const CHANGING = new Set(["edit", "undo", "save", "place", "open", "new_document", "export"]);

const APPS: ToolDef = {
  name: "apps",
  readOnly: true,
  description:
    "Which creative apps this server can work in, and whether each one is ready: installed, open, allowed to be controlled, and (After Effects) free of dialogs. " +
    "Also each app's scripting language and what it can do. Read-only, and it never opens an app. Call it first.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

const NEW_DOCUMENT: ToolDef = {
  name: "new_document",
  appScoped: true,
  description:
    "Make a new document in an app and make it the active one: Illustrator (RGB, width and height in points), Photoshop (pixels), " +
    "or After Effects (a new composition in the open project, in pixels). Nothing is saved.",
  inputSchema: {
    type: "object",
    properties: {
      width: { type: "number", description: "Width (points in Illustrator, pixels elsewhere)." },
      height: { type: "number", description: "Height (points in Illustrator, pixels elsewhere)." },
      name: { type: "string", description: "Photoshop and After Effects: the new document's or composition's name." },
    },
    required: [],
  },
};

function documentsTool(appIds: string[]): ToolDef {
  return {
    name: "documents",
    readOnly: true,
    description:
      "The documents open in an app, or in every open app when app is left out: each one's name, its path when it's saved, and which one is active. " +
      "Pass a document's name (and path) as `doc` to the other tools to act on it rather than on the one in front.",
    inputSchema: {
      type: "object",
      properties: { app: { type: "string", enum: appIds, description: "Which app. Leave out for every open app." } },
      required: [],
    },
  };
}

// Tools where a target document makes no sense: they act on the app, not a document.
const NO_DOC = new Set(["guide", "open", "new_document"]);

/** The tools for these connectors. With none (an unsupported system), only `apps`. */
export function mcpTools(connectors: Map<string, Connector>, mod: string): ToolDef[] {
  if (!connectors.size) return [APPS];
  const manifests = [...connectors.values()].map((c) => c.manifest);
  const supported = supportedAppTools(manifests);
  if (manifests.some((m) => m.capabilities.newDocument)) supported.add("new_document");
  const defs: Record<string, ToolDef> = { ...appToolDefs(mod, { scripts: "refuse" }), new_document: NEW_DOCUMENT };
  const appIds = [...connectors.keys()];
  const target = { appIds, multiApp: connectors.size > 1 };
  const out: ToolDef[] = [];
  for (const name of MCP_TOOL_ORDER) {
    if (name === "apps") out.push(APPS);
    else if (name === "documents") out.push(documentsTool(appIds));
    else if (supported.has(name) && defs[name]) out.push(dropDoc(withTarget(defs[name], target), NO_DOC.has(name)));
  }
  return out;
}

function dropDoc(t: ToolDef, drop: boolean): ToolDef {
  if (!drop) return t;
  const schema = t.inputSchema as { properties?: Record<string, unknown> };
  const { doc: _doc, ...properties } = schema.properties || {};
  return { ...t, inputSchema: { ...t.inputSchema, properties } };
}

/** A tool as MCP lists it, with hints for clients that show or gate tools. */
export function listed(t: ToolDef): Record<string, unknown> {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      readOnlyHint: !!t.readOnly,
      destructiveHint: t.name === "save",
      openWorldHint: false,
    },
  };
}
