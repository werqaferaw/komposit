// The system prompt for this computer (Cmd on a Mac, Ctrl on Windows). It is
// built in core/system.mjs, which the web page uses too.
import platform from "../platform/index.mjs";
import { buildSystem as build } from "./core/system.mjs";

export function buildSystem(app) {
  return build(app, { mod: platform.keys.mod });
}
