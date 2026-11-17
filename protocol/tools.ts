// The toolbox: one set of tools every AI gets. The core serves it (over MCP on a private
// local socket); the bridge program connects AIs to it. Each AI run carries a pass that
// says what it may touch, and the core checks it on every call.

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the input. */
  inputSchema: Record<string, unknown>;
  /** Takes an `app` argument and goes through that app's lane. */
  appScoped?: boolean;
  /** Never changes anything (no approval, may run while the app is busy with other reads). */
  readOnly?: boolean;
}

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/** Issued by the core for one AI run; the bridge presents its token on connect. */
export interface RunPass {
  token: string;
  runId: string;
  chatId: string;
  turnId: string;
  /** Apps this run may use; "all" = every app (the chat's switches still apply via asks). */
  apps: string[] | "all";
  projectRoot?: string;
  expiresAt: number;
}

export interface ToolCall {
  runId: string;
  callId: string;
  name: string;
  input: Record<string, unknown>;
}
