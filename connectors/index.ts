// The connectors the core loads, by app id. The core never names an app: it calls
// loadConnectors() and talks to each one through protocol/connector.ts.
//
// Illustrator, Photoshop and After Effects through scripting (door "os-script"); Premiere Pro
// through Komposit's own panel inside it (door "in-app-plugin"), installed with
// installPremierePanel when the person asks for it.
import type { Platform } from "../protocol/common.ts";
import type { Connector } from "../protocol/connector.ts";
import { createKit } from "./_kit/adobe.ts";
import type { ConnectorOptions } from "./_kit/adobe.ts";
import { createAfterEffects } from "./aftereffects/index.ts";
import { createIllustrator } from "./illustrator/index.ts";
import { createPhotoshop } from "./photoshop/index.ts";
import { createPremiere } from "./premiere/index.ts";

export type { ConnectorOptions, CallOptions } from "./_kit/adobe.ts";
export type { Incident, OnIncident } from "./_kit/incidents.ts";
export type { ScriptTransport } from "./_kit/transport.ts";
export { installPremierePanel, removePremierePanel, premierePanelState, PANEL_ID as PREMIERE_PANEL_ID } from "./premiere/install.ts";
export type { DebugModeSwitch, PanelInstallOptions, PanelState, PanelStateOptions } from "./premiere/install.ts";

export function loadConnectors(platform: Platform, opts: ConnectorOptions = {}): Map<string, Connector> {
  // One kit for all four: one transport, one scratch folder, one incident log, one dialog
  // watch, and one After Effects readiness check.
  const kit = createKit(platform, opts);
  const all = [
    createIllustrator(kit),
    createPhotoshop(kit),
    createAfterEffects(kit),
    createPremiere(kit, {
      ...(opts.premierePanelFile ? { panelFile: opts.premierePanelFile } : {}),
      ...(opts.cepExtensionsDir ? { extensionsDir: opts.cepExtensionsDir } : {}),
      ...(opts.cepDebugMode ? { debugMode: opts.cepDebugMode } : {}),
      ...(opts.home ? { home: opts.home } : {}),
    }),
  ];
  return new Map(all.filter((c) => c.manifest.platforms.includes(platform)).map((c) => [c.manifest.id, c]));
}
