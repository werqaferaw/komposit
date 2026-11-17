// Reading and answering an app's dialogs through Accessibility.
//
// Ported from 1.0's JXA (companion/platform/mac.mjs, AX_JXA), which went through
// System Events. Here the helper asks the AX API directly, so the permission is
// Komposit's own and a busy app can't hang the call (a 3 s messaging timeout).
//
// What 1.0 learned:
//  - dialogs are windows whose subrole is AXDialog or AXSystemDialog, plus any
//    sheets attached to a window;
//  - look at no more than 160 elements per dialog, keep at most 12 texts and
//    8 buttons, and skip the window's close/minimise/zoom/full-screen buttons;
//  - some Adobe dialogs are drawn by the app itself and expose nothing: those
//    come back with no text, and the core falls back to a picture of the window;
//  - without the permission, AX calls fail with -25211 (kAXErrorAPIDisabled).
import ApplicationServices
import AppKit
import Foundation

private let maxElements = 160
private let maxTexts = 12
private let maxButtons = 8
private let windowButtonSubroles: Set<String> = ["AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"]

/// ax.trusted { prompt } -> { trusted }. prompt:true shows the system's prompt (only when the person asked for it).
func axTrusted(_ p: Params) throws -> Any {
  let prompt = optBool(p, "prompt") ?? false
  let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
  return ["trusted": AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)]
}

private func notTrusted() -> HelperError {
  HelperError(
    code: Codes.notTrusted, kind: "notTrusted",
    message: "Komposit needs the Accessibility permission to read and answer dialogs. Turn it on in System Settings > Privacy & Security > Accessibility.")
}

private func attr(_ el: AXUIElement, _ name: String) throws -> CFTypeRef? {
  var v: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(el, name as CFString, &v)
  if err == .apiDisabled { throw notTrusted() }
  return err == .success ? v : nil
}

private func text(_ el: AXUIElement, _ name: String) throws -> String {
  guard let v = try attr(el, name) else { return "" }
  if let s = v as? String { return s }
  if let a = v as? NSAttributedString { return a.string }
  return ""
}

private func elements(_ el: AXUIElement, _ name: String) throws -> [AXUIElement] {
  guard let v = try attr(el, name) else { return [] }
  return (v as? [AXUIElement]) ?? []
}

private func buttonName(_ el: AXUIElement) throws -> String {
  var n = try text(el, kAXTitleAttribute)
  if n.isEmpty { n = try text(el, kAXDescriptionAttribute) }
  return n.trimmingCharacters(in: .whitespacesAndNewlines)
}

private struct Box { let el: AXUIElement; let kind: String; let window: AXUIElement }

/// The app's dialogs and sheets, frontmost first (AXWindows is ordered front to back).
private func boxes(_ app: AXUIElement) throws -> [Box] {
  var out: [Box] = []
  for win in try elements(app, kAXWindowsAttribute) {
    for c in try elements(win, kAXChildrenAttribute) where try text(c, kAXRoleAttribute) == "AXSheet" {
      out.append(Box(el: c, kind: "sheet", window: win))
    }
    let sub = try text(win, kAXSubroleAttribute)
    if sub == "AXDialog" || sub == "AXSystemDialog" { out.append(Box(el: win, kind: "dialog", window: win)) }
  }
  return out
}

/// Depth-first, like JXA's entireContents, capped at 160 elements.
private func walk(_ root: AXUIElement, _ visit: (AXUIElement, String) throws -> Bool) throws {
  var stack = try elements(root, kAXChildrenAttribute).reversed() as [AXUIElement]
  var seen = 0
  while let el = stack.popLast(), seen < maxElements {
    seen += 1
    let role = try text(el, kAXRoleAttribute)
    if try visit(el, role) { return }
    stack.append(contentsOf: try elements(el, kAXChildrenAttribute).reversed())
  }
}

private func describe(_ box: Box) throws -> [String: Any] {
  var title = try text(box.el, kAXTitleAttribute)
  if title.isEmpty { title = try text(box.window, kAXTitleAttribute) }
  var texts: [String] = []
  var buttons: [String] = []
  var fields = 0
  try walk(box.el) { el, role in
    switch role {
    case "AXStaticText":
      var v = try text(el, kAXValueAttribute)
      if v.isEmpty { v = try text(el, kAXTitleAttribute) }
      v = v.trimmingCharacters(in: .whitespacesAndNewlines)
      if !v.isEmpty && !texts.contains(v) && texts.count < maxTexts { texts.append(String(v.prefix(600))) }
    case "AXButton":
      if windowButtonSubroles.contains(try text(el, kAXSubroleAttribute)) { break }
      let n = try buttonName(el)
      if !n.isEmpty && !buttons.contains(n) && buttons.count < maxButtons { buttons.append(String(n.prefix(60))) }
    case "AXTextField", "AXTextArea", "AXComboBox":
      fields += 1
    default: break
    }
    return false
  }
  var d: [String: Any] = ["kind": box.kind, "title": title, "text": texts, "buttons": buttons, "fields": fields]
  if let def = try attr(box.el, kAXDefaultButtonAttribute), CFGetTypeID(def) == AXUIElementGetTypeID() {
    d["defaultButton"] = try buttonName(def as! AXUIElement)
  }
  if let cancel = try attr(box.el, kAXCancelButtonAttribute), CFGetTypeID(cancel) == AXUIElementGetTypeID() {
    d["cancelButton"] = try buttonName(cancel as! AXUIElement)
  }
  return d
}

private func appElement(_ p: Params) throws -> (AXUIElement, String) {
  let pid = try reqInt(p, "pid")
  guard let app = NSRunningApplication(processIdentifier: pid_t(pid)), !app.isTerminated else {
    throw HelperError(code: Codes.notRunning, kind: "notRunning", message: "That app isn't open any more.")
  }
  guard AXIsProcessTrusted() else { throw notTrusted() }
  let el = AXUIElementCreateApplication(pid_t(pid))
  AXUIElementSetMessagingTimeout(el, 3.0)
  return (el, appLabel(app, fallback: "The app"))
}

/// ax.dialog { pid } -> { dialogs: [{ kind, title, text, buttons, fields, defaultButton?, cancelButton? }] }
/// Frontmost first, at most 4. Empty when the app shows none.
func axDialog(_ p: Params) throws -> Any {
  let (app, _) = try appElement(p)
  let found = try boxes(app)
  return ["dialogs": try found.prefix(4).map(describe)]
}

/// ax.press { pid, button } presses that button (by its name, any case) in the
/// frontmost dialog that has it; { pid, key: "return" | "escape" } presses the
/// dialog's default or cancel button. -> { pressed: name }
/// The core decides which buttons an agent may press (never Save, Don't Save,
/// Delete, Replace...); this only does what it's told.
func axPress(_ p: Params) throws -> Any {
  let (app, label) = try appElement(p)
  let found = try boxes(app)
  if found.isEmpty {
    throw HelperError(code: Codes.notFound, kind: "notFound", message: "\(label) isn't showing a dialog right now.")
  }
  if let key = optString(p, "key") {
    let attrName: String
    switch key {
    case "return": attrName = kAXDefaultButtonAttribute
    case "escape": attrName = kAXCancelButtonAttribute
    default: throw HelperError.invalidParams("key must be return or escape.")
    }
    for box in found {
      if let b = try attr(box.el, attrName), CFGetTypeID(b) == AXUIElementGetTypeID() {
        let button = b as! AXUIElement
        let name = try buttonName(button)
        try press(button, label: label, name: name)
        return ["pressed": name]
      }
    }
    throw HelperError(code: Codes.notFound, kind: "notFound", message: "\(label)'s dialog has no \(key == "return" ? "default" : "cancel") button to press.")
  }
  let want = try reqString(p, "button").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  for box in found {
    var hit: AXUIElement?
    var hitName = ""
    try walk(box.el) { el, role in
      guard role == "AXButton" else { return false }
      let n = try buttonName(el)
      if n.lowercased() == want { hit = el; hitName = n; return true }
      return false
    }
    if let hit {
      try press(hit, label: label, name: hitName)
      return ["pressed": hitName]
    }
  }
  throw HelperError(code: Codes.notFound, kind: "notFound", message: "\(label)'s dialog has no button called \(want).")
}

private func press(_ el: AXUIElement, label: String, name: String) throws {
  let err = AXUIElementPerformAction(el, kAXPressAction as CFString)
  if err == .apiDisabled { throw notTrusted() }
  if err != .success {
    throw HelperError(
      code: Codes.failed, kind: "failed",
      message: "\(label) didn't take the press on \(name). It may be busy; try again in a moment.",
      data: ["axError": Int(err.rawValue)])
  }
}
