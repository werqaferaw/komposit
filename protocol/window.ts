// The window's private line to the core, as the app's preload exposes it:
//   window.komposit = { connect(): Promise<KompositPort>, platform, version }
// connect() resolves with the current port, or waits for the next one. The shell hands the
// window a fresh port whenever the page loads or the core restarts.
//
// Reconnecting: when a newer port arrives, the old one gets one JSON-RPC notification,
// RECONNECT_METHOD, and is then closed. On it, call connect() again and catch up from the
// last event seen (chats.events {since}).

/** One connection to the core: JSON-RPC 2.0 messages in and out (protocol/rpc.ts). */
export interface KompositPort {
  postMessage(msg: unknown): void;
  /** Returns an unsubscribe function. */
  onMessage(cb: (msg: unknown) => void): () => void;
  close(): void;
}

export interface KompositBridge {
  connect(): Promise<KompositPort>;
  platform: "mac" | "win";
  version: string;
  /** The progress window over the person's apps (ui/overlay.html) talks to the shell: what it
   *  wants ("running" | "ending" | "idle", see shell/overlay-rules.ts), a click that brings
   *  Komposit's window forward at a chat, the size it needs (CSS px; the shell keeps it anchored
   *  at the bottom-right corner), and whether it may take keys (only while the pointer is over a
   *  text box: it never activates Komposit). The shell takes these from that window only. */
  overlay?: {
    wants(state: "running" | "ending" | "idle"): void;
    open(chatId: string): void;
    size?(width: number, height: number): void;
    focusable?(on: boolean): void;
  };
  /** The main window: the shell asks it to open a chat (a click on the progress window). */
  onOpenChat?(listener: (chatId: string) => void): void;
  /** Where a picked, dropped or pasted file is on this computer ("" for one that isn't on disk,
   *  like a pasted screenshot), so it can be attached by its path: whole, however big. */
  pathFor?(file: File): string;
}

/** The notification an old port hears just before it is closed. Sent by the shell, not the core. */
export const RECONNECT_METHOD = "komposit.reconnect";

export interface ReconnectNotice {
  jsonrpc: "2.0";
  method: typeof RECONNECT_METHOD;
  params: { reason: "new-connection" };
}
