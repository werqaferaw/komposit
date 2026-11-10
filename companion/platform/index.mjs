// The platform layer: everything that differs between macOS and Windows.
//
// The bridges, the server and the setup code call only this; they never run
// osascript, pgrep, JXA, tasklist or COM themselves. mac.mjs and win.mjs export
// the same names:
//
//   name, device, keys                 "mac" | "win", "Mac" | "PC", { mod: "Cmd" | "Ctrl" }
//   defaultDataDir(), logFile()        settings/chats folder, the app's server log
//   isInside(dir, p), designFolders()  path checks; Desktop, Documents, Downloads
//   folderPrompts                      true when the OS asks before those folders are read
//   runJsx(app, src, {via, timeoutMs, signal})   run ExtendScript in an Adobe app
//   activateApp(app), aeScriptSettings
//   runningApps(), isAppRunning(app), appPid(app), processUptime(pid)
//   appWindows(app)                    id -> { w, h, layer } (8 = modal dialog)
//   BUNDLE_IDS, installedApps(), launchApp(app)
//   helperPath(), automationState(app, {ask}), openSettingsPane(kind)
//   openPath(path), thumbnail(path, outDir, cachedPath)
//   loginPath(run), extraBinDirs(), systemPathDirs, claudeNames, codexNames
//   groupSpawnOptions, killTree(child), watchParent(onOrphan)
import * as mac from "./mac.mjs";
import * as win from "./win.mjs";

export const platform = process.platform === "win32" ? win : mac;
export default platform;
export { mac, win };
