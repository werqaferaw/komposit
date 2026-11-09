// The behaviour text for this computer (Cmd on a Mac, Ctrl on Windows). The
// text itself lives in core/behavior.mjs, which the web page uses too.
import platform from "../platform/index.mjs";
import { behavior } from "./core/behavior.mjs";

export const BEHAVIOR = behavior(platform.keys.mod);
