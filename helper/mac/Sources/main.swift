// komposit-helper: the Mac's native side of Komposit. It runs beside the core
// and answers JSON-RPC 2.0 over stdin/stdout, one JSON object per line.
// See helper/mac/README.md for every method.
//
// It lives inside Komposit.app, so macOS attributes Automation and
// Accessibility checks (and prompts) to Komposit. It never asks for a
// permission unless a request explicitly says so (ask/prompt: true).
//
// `komposit-helper bridge` is something else: the bridge an AI starts to reach
// the core's toolbox (Bridge.swift). It is told apart before anything else
// runs, so a bridge never says "ready" or watches the Mac's heat.
import Foundation

if CommandLine.arguments.dropFirst().first == "bridge" { runBridge() }

let helperVersion = "0.1.0-alpha.1"
let protocolVersion = 1

#if arch(arm64)
let helperArch = "arm64"
#elseif arch(x86_64)
let helperArch = "x86_64"
#else
let helperArch = "unknown"
#endif

let methods: [String: Method] = [
  "ping": { _ in ["pong": true, "t": Int(Date().timeIntervalSince1970 * 1000)] },
  "version": { _ in
    let os = ProcessInfo.processInfo.operatingSystemVersion
    return [
      "name": "komposit-helper", "version": helperVersion, "protocol": protocolVersion, "arch": helperArch,
      "os": "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)", "pid": Int(ProcessInfo.processInfo.processIdentifier),
    ]
  },
  "appleEvents.runScript": runScript,
  "appleEvents.permission": automationPermission,
  "windows.list": listWindows,
  "ax.trusted": axTrusted,
  "ax.dialog": axDialog,
  "ax.press": axPress,
  "system.thermal": thermal,
  "power.assertion": powerAssertion,
  "files.trash": trash,
  "quicklook.thumbnail": thumbnail,
]

// Tell the core we're up (it can measure startup from this).
notify("ready", ["version": helperVersion, "protocol": protocolVersion, "arch": helperArch])

// Heat changes arrive as a notification so the core can slow down without polling.
let thermalObserver = NotificationCenter.default.addObserver(
  forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil
) { _ in
  if let r = try? thermal([:]) as? [String: Any] { notify("system.thermalChanged", r) }
}

// Read until the core closes stdin (it quit or crashed), then finish what's
// running, let go of the power assertion and exit. Every method is bounded
// (scripts by timeoutMs, Accessibility by a 3 s messaging timeout, thumbnails
// by timeoutMs), so this wait ends.
while let line = readLine(strippingNewline: true) {
  handleLine(line, methods: methods)
}
inFlight.wait()
releasePower()
exit(0)
