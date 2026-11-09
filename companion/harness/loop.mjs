// The API engine's loop on this computer: core/loop.mjs (the same loop the web
// page runs) wired to this computer's bridges, its modifier key and the step
// limit from the environment.
import { getBridge } from "../bridges/index.mjs";
import { executeTool } from "./tools.mjs";
import { env } from "../env.mjs";
import platform from "../platform/index.mjs";
import { runTurn as runLoop } from "./core/loop.mjs";

export function runTurn({ app, bridge = getBridge(app), maxToolCalls = env.maxToolCalls, ...rest }) {
  return runLoop({
    app,
    maxToolCalls,
    mod: platform.keys.mod,
    runTool: (name, input) => executeTool(bridge, name, input),
    ...rest,
  });
}
