// What the core may ask the app shell to do: things only the shell can (the Keychain,
// keeping the Mac awake, notifications, the folder picker, the browser for sign-in).
// Carried as JSON-RPC over Electron's parent port. In tests and headless runs the core
// gets an in-memory stand-in.

export interface HostMethods {
  "secrets.get": { params: { key: string }; result: string | null };
  "secrets.set": { params: { key: string; value: string }; result: true };
  "secrets.delete": { params: { key: string }; result: true };
  "power.keepAwake": { params: { on: boolean; reason: string }; result: true };
  "notify": { params: { title: string; body: string; chatId?: string }; result: true };
  "openExternal": { params: { url: string }; result: true };
  "pickFolder": { params: { prompt?: string }; result: string | null };
  /** Runs the gateway's Google sign-in in the system browser and returns the session (ks_...),
   *  or why it didn't finish as one plain sentence. Null: a newer sign-in replaced this one. */
  "signIn": { params: { gateway: string }; result: { session: string } | { error: string } | null };
}

/** Sent by the shell to the core when it starts it. */
export interface CoreStartOptions {
  dataDir: string;
  /** Folder for the private toolbox socket. */
  runDir: string;
  appVersion: string;
  platform: "mac" | "win";
  /** The bridge an AI starts to reach the toolbox: the Mac app's native `komposit-helper
   *  bridge`, or the Node bridge (bridge/bridge.ts) with the Node or Electron binary that runs
   *  it. `env` is added to its environment (the Node bridge on Electron needs
   *  ELECTRON_RUN_AS_NODE=1; the native one gets none). */
  bridge: { command: string; args: string[]; env?: Record<string, string> };
  gateway: string;
  dev: boolean;
  /** A clean profile for recording a demo (the app's --demo): Komposit 1.0's chats aren't
   *  brought in, and recent files come only from project folders, so none of the person's
   *  other files show on the start screen. */
  demo?: boolean;
}
