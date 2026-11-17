// Scripts into the creative apps, and the Automation permission, over Apple Events.
//
// 1.0 ran `osascript` per call with an AppleScript `tell ... do javascript`. Here
// the helper sends the Apple Event itself (AESendMessage), so:
//  - the macOS Automation prompt names the app the helper lives in (Komposit);
//  - errors come back typed (-1743 denied, -1712 timed out, the app's own
//    script error text) instead of being parsed out of osascript's stderr;
//  - nothing needs the app's scripting dictionary at compile time.
//
// The event codes come from the apps' own .sdef files (2026 versions):
//   Illustrator, Photoshop  `do javascript`  misc/DjxM  (direct parameter: the code)
//   After Effects           `DoScript`       misc/dosc  (returns nothing useful;
//                                                       1.0 had the script write
//                                                       its result to a file)
import AppKit
import CoreServices
import Foundation

func fourCC(_ s: String) -> FourCharCode {
  s.utf8.reduce(0) { ($0 << 8) | FourCharCode($1) }
}

/// The running copy of an app, by bundle id or pid. Never launches anything.
func runningApp(bundleId: String?, pid: Int?) -> NSRunningApplication? {
  if let pid {
    guard let app = NSRunningApplication(processIdentifier: pid_t(pid)), !app.isTerminated else { return nil }
    if let bundleId, app.bundleIdentifier?.lowercased() != bundleId.lowercased() { return nil }
    return app
  }
  guard let bundleId else { return nil }
  // After Effects: every version shares one bundle id; any running one will do
  // (the core picks a pid when two are open).
  return NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first { !$0.isTerminated }
}

/// A friendly name for messages: "Adobe Illustrator 2026" -> "Illustrator".
func appLabel(_ app: NSRunningApplication?, fallback: String) -> String {
  let raw = app?.localizedName ?? fallback
  let low = raw.lowercased()
  if low.contains("illustrator") { return "Illustrator" }
  if low.contains("photoshop") { return "Photoshop" }
  if low.contains("after effects") || low.contains("aftereffects") { return "After Effects" }
  if low.contains("premiere") { return "Premiere Pro" }
  if low.contains("indesign") { return "InDesign" }
  // A bare bundle id ("com.example.app") reads badly in a sentence.
  if app == nil && raw.contains(".") && !raw.contains(" ") { return "That app" }
  return raw
}

/// appleEvents.runScript { bundleId?, pid?, code, timeoutMs?, verb? } -> { result, app, pid, ms }
func runScript(_ p: Params) throws -> Any {
  let bundleId = optString(p, "bundleId")
  let pidParam = optInt(p, "pid")
  if bundleId == nil && pidParam == nil { throw HelperError.invalidParams("Say which app: a bundleId or a pid.") }
  guard let code = p["code"] as? String else { throw HelperError.invalidParams("The request is missing code.") }
  let timeoutMs = max(1000, optInt(p, "timeoutMs") ?? 120_000)
  let verb = optString(p, "verb") ?? "javascript"
  let eventID: FourCharCode
  switch verb {
  case "javascript": eventID = fourCC("DjxM")
  case "doScript": eventID = fourCC("dosc")
  default: throw HelperError.invalidParams("verb must be javascript or doScript.")
  }

  guard let app = runningApp(bundleId: bundleId, pid: pidParam) else {
    let name = bundleId.map { appLabel(nil, fallback: $0) } ?? "That app"
    throw HelperError(code: Codes.notRunning, kind: "notRunning", message: "\(name) isn't open. Open it, then try again.")
  }
  let label = appLabel(app, fallback: bundleId ?? "The app")
  let pid = app.processIdentifier

  let target = NSAppleEventDescriptor(processIdentifier: pid)
  let event = NSAppleEventDescriptor(
    eventClass: fourCC("misc"), eventID: eventID, targetDescriptor: target,
    returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
  event.setParam(NSAppleEventDescriptor(string: code), forKeyword: keyDirectObject)
  guard let aeEvent = event.aeDesc else {
    throw HelperError(code: Codes.failed, kind: "failed", message: "The helper couldn't build the script message.")
  }

  var replyDesc = AEDesc()
  // AESendMessage counts in ticks (1/60 s). It blocks this worker thread only.
  let ticks = Int(ceil(Double(timeoutMs) / 1000.0 * 60.0))
  let started = Date()
  let err = AESendMessage(aeEvent, &replyDesc, AESendMode(kAEWaitReply | kAECanInteract), ticks)
  let ms = Int(Date().timeIntervalSince(started) * 1000)
  let reply = NSAppleEventDescriptor(aeDescNoCopy: &replyDesc)

  switch Int(err) {
  case Int(noErr): break
  case -1743: // errAEEventNotPermitted
    throw HelperError(
      code: Codes.automationDenied, kind: "automationDenied",
      message: "Komposit is not allowed to control \(label). Turn it on in System Settings > Privacy & Security > Automation.",
      data: ["osStatus": -1743])
  case -1712: // errAETimeout
    throw HelperError(
      code: Codes.timeout, kind: "timeout",
      message: "\(label) didn't answer in time. If it's showing a dialog, close it. The step may still finish inside the app, so check before retrying.",
      data: ["osStatus": -1712, "ms": ms])
  case -600, -609: // procNotFound, connectionInvalid: it quit (or crashed) while we waited
    throw HelperError(
      code: Codes.notRunning, kind: "notRunning",
      message: "\(label) closed before the script finished. Open it again, then try again.",
      data: ["osStatus": Int(err)])
  default:
    throw HelperError(
      code: Codes.failed, kind: "failed",
      message: "\(label) couldn't be reached to run the script. If it was just opened or the screen restarted, quit and reopen Komposit, then try again.",
      data: ["osStatus": Int(err)])
  }

  // The app answered, but the script itself may have failed: errn/errs in the reply.
  let errNum = reply.paramDescriptor(forKeyword: keyErrorNumber)?.int32Value ?? 0
  let errStr = reply.paramDescriptor(forKeyword: keyErrorString)?.stringValue
  if errNum != 0 || errStr != nil {
    if errNum == -1743 {
      throw HelperError(
        code: Codes.automationDenied, kind: "automationDenied",
        message: "Komposit is not allowed to control \(label). Turn it on in System Settings > Privacy & Security > Automation.",
        data: ["osStatus": -1743])
    }
    let text = (errStr?.isEmpty == false ? errStr! : "The script stopped with an error.")
    throw HelperError(
      code: Codes.scriptError, kind: "scriptError", message: text,
      data: ["appError": Int(errNum), "app": label])
  }

  var result = ""
  if let direct = reply.paramDescriptor(forKeyword: keyDirectObject) {
    result = direct.stringValue ?? direct.coerce(toDescriptorType: typeUnicodeText)?.stringValue ?? ""
  }
  return ["result": result, "app": label, "pid": Int(pid), "ms": ms]
}

/// appleEvents.permission { bundleId, ask } -> { status, osStatus }
/// Ported from 1.0's packaging/macos/helper.swift. With ask, macOS shows its
/// consent dialog when the answer isn't decided yet (only if the app is running).
func automationPermission(_ p: Params) throws -> Any {
  let bundleId = try reqString(p, "bundleId")
  let ask = optBool(p, "ask") ?? false
  let target = NSAppleEventDescriptor(bundleIdentifier: bundleId)
  guard let desc = target.aeDesc else {
    throw HelperError(code: Codes.failed, kind: "failed", message: "The helper couldn't check that app.")
  }
  let status = AEDeterminePermissionToAutomateTarget(desc, AEEventClass(typeWildCard), AEEventID(typeWildCard), ask)
  let name: String
  switch Int(status) {
  case 0: name = "granted"
  case -1743: name = "denied"
  case -1744: name = "notDetermined"
  case -600: name = "notRunning"
  default: name = "unknown"
  }
  return ["status": name, "osStatus": Int(status)]
}
