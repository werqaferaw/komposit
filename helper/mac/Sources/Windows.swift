// The apps' windows through CoreGraphics: no permission needed, about a
// millisecond. Ported from 1.0's companion/platform/mac.mjs (which did the same
// through JXA in ~0.1 s) and companion/dialogwatch.mjs (the dialog guess).
//
// What 1.0 learned about window layers:
//  - layer 8 is where modal panels sit, 0 is normal windows;
//  - After Effects' script errors and alerts are modal (layer 8) and silently
//    block every later script, so "a layer-8 window is up" is a good test there;
//  - Illustrator keeps a PERMANENT layer-8 window, so for it the only reliable
//    test is "a new window appeared since the step started and is still there
//    on the next look" (pass the earlier ids as `baseline`);
//  - anything under 150 x 80 is a tooltip or a menu, not a dialog.
//  - Window titles (kCGWindowName) are only filled in with the Screen Recording
//    permission; without it they are simply missing. Never ask for it here.
import CoreGraphics
import Foundation

let dialogMinWidth = 150.0
let dialogMinHeight = 80.0

/// windows.list { pid?, ownerPrefix?, baseline?, onScreenOnly? }
///   -> { windows: [...], dialogs: { modal: [ids], new: [ids] | null } }
func listWindows(_ p: Params) throws -> Any {
  let pidFilter = optInt(p, "pid")
  let ownerPrefix = optString(p, "ownerPrefix")
  let onScreenOnly = optBool(p, "onScreenOnly") ?? false
  let baseline: Set<Int>? = (p["baseline"] as? [Any]).map { Set($0.compactMap { ($0 as? NSNumber)?.intValue }) }

  // 1.0 used option 0 (all windows): a dialog can be briefly off screen while it opens.
  let options: CGWindowListOption = onScreenOnly ? [.optionOnScreenOnly, .excludeDesktopElements] : [.optionAll, .excludeDesktopElements]
  guard let info = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    throw HelperError(code: Codes.failed, kind: "failed", message: "The window list couldn't be read.")
  }

  var windows: [[String: Any]] = []
  var modal: [Int] = []
  var fresh: [Int] = []
  for w in info {
    let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? 0
    let owner = w[kCGWindowOwnerName as String] as? String ?? ""
    if let pidFilter, pid != pidFilter { continue }
    if let ownerPrefix, !owner.hasPrefix(ownerPrefix) { continue }
    let id = (w[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0
    let layer = (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
    var x = 0.0, y = 0.0, width = 0.0, height = 0.0
    if let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) {
      x = Double(r.origin.x); y = Double(r.origin.y); width = Double(r.width); height = Double(r.height)
    }
    var entry: [String: Any] = [
      "id": id, "pid": pid, "owner": owner, "layer": layer,
      "bounds": ["x": x.rounded(), "y": y.rounded(), "w": width.rounded(), "h": height.rounded()],
      "onScreen": (w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
      "alpha": (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
    ]
    if let title = w[kCGWindowName as String] as? String { entry["title"] = title }
    windows.append(entry)

    let bigEnough = width >= dialogMinWidth && height >= dialogMinHeight
    if bigEnough && layer == 8 { modal.append(id) }
    if bigEnough, let baseline, !baseline.contains(id) { fresh.append(id) }
  }
  return [
    "windows": windows,
    "dialogs": ["modal": modal, "new": baseline == nil ? NSNull() : fresh as Any],
  ]
}
