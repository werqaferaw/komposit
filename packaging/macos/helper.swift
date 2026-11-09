// komposit-helper: small checks the Node server can't do itself.
//
//   komposit-helper automation <bundle-id> [--ask]
//     Is Komposit allowed to control that app (macOS Automation permission)?
//     Prints {"status": N}: 0 allowed, -1743 denied, -1744 not decided yet,
//     -600 app not running. With --ask, macOS shows its consent dialog if the
//     answer isn't decided yet (and the app is running).
//
// It lives inside Komposit.app, so macOS attributes the check to Komposit.
import Foundation
import CoreServices

let args = CommandLine.arguments
guard args.count >= 3, args[1] == "automation" else {
  FileHandle.standardError.write("usage: komposit-helper automation <bundle-id> [--ask]\n".data(using: .utf8)!)
  exit(64)
}
let target = NSAppleEventDescriptor(bundleIdentifier: args[2])
let ask = args.contains("--ask")
let status = AEDeterminePermissionToAutomateTarget(target.aeDesc, AEEventClass(typeWildCard), AEEventID(typeWildCard), ask)
print("{\"status\": \(status)}")
exit(0)
