// Heat, staying awake, the Trash and thumbnails.
import AppKit
import Foundation
import ImageIO
import IOKit.pwr_mgt
import QuickLookThumbnailing
import UniformTypeIdentifiers

// ---- system.thermal ---------------------------------------------------------------

func thermal(_ p: Params) throws -> Any {
  let s: String
  switch ProcessInfo.processInfo.thermalState {
  case .nominal: s = "nominal"
  case .fair: s = "fair"
  case .serious: s = "serious"
  case .critical: s = "critical"
  @unknown default: s = "unknown"
  }
  return ["state": s, "lowPowerMode": ProcessInfo.processInfo.isLowPowerModeEnabled]
}

// ---- power.assertion --------------------------------------------------------------
// One assertion at most, held until turned off or the helper exits (macOS drops
// an assertion when its process ends, so a crash can't keep the Mac awake).

private let powerLock = NSLock()
private var powerId: IOPMAssertionID = 0
private var powerOn = false

func powerAssertion(_ p: Params) throws -> Any {
  guard let on = optBool(p, "on") else { throw HelperError.invalidParams("Say on: true or false.") }
  let reason = optString(p, "reason") ?? "Komposit is working in your apps"
  powerLock.lock()
  defer { powerLock.unlock() }
  if on {
    if powerOn { return ["on": true, "changed": false] }
    var id: IOPMAssertionID = 0
    let r = IOPMAssertionCreateWithName(
      kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
      IOPMAssertionLevel(kIOPMAssertionLevelOn), reason as CFString, &id)
    guard r == kIOReturnSuccess else {
      throw HelperError(code: Codes.failed, kind: "failed", message: "The Mac wouldn't agree to stay awake.", data: ["ioReturn": Int(r)])
    }
    powerId = id
    powerOn = true
    return ["on": true, "changed": true]
  }
  if !powerOn { return ["on": false, "changed": false] }
  IOPMAssertionRelease(powerId)
  powerOn = false
  powerId = 0
  return ["on": false, "changed": true]
}

func releasePower() {
  powerLock.lock()
  if powerOn { IOPMAssertionRelease(powerId); powerOn = false }
  powerLock.unlock()
}

// ---- files.trash ------------------------------------------------------------------
// The system's own call: the person can put things back, and no Finder
// automation is needed (1.0 did the same through JXA).

func trash(_ p: Params) throws -> Any {
  guard let list = p["paths"] as? [Any], !list.isEmpty else { throw HelperError.invalidParams("The request is missing paths.") }
  var out: [[String: Any]] = []
  for item in list {
    guard let path = item as? String, path.hasPrefix("/") else {
      out.append(["path": "\(item)", "ok": false, "error": "That isn't a full path."])
      continue
    }
    let url = URL(fileURLWithPath: path)
    if !FileManager.default.fileExists(atPath: path) {
      out.append(["path": path, "ok": false, "error": "There's nothing there any more."])
      continue
    }
    var landed: NSURL?
    do {
      try FileManager.default.trashItem(at: url, resultingItemURL: &landed)
      var r: [String: Any] = ["path": path, "ok": true]
      if let landed, let lp = landed.path { r["trashedTo"] = lp }
      out.append(r)
    } catch {
      out.append(["path": path, "ok": false, "error": "It couldn't be moved to the Trash: \(error.localizedDescription)"])
    }
  }
  return ["results": out]
}

// ---- quicklook.thumbnail ----------------------------------------------------------
// QLThumbnailGenerator with a time limit: 1.0's qlmanage could hang for good on
// .aep files, so this gives up after timeoutMs and says so.

private final class ThumbBox: @unchecked Sendable {
  var image: CGImage?
  var type: String = ""
  var error: String?
}

func thumbnail(_ p: Params) throws -> Any {
  let path = try reqString(p, "path")
  let size = Double(max(16, min(optInt(p, "size") ?? 400, 2048)))
  let timeoutMs = max(1000, optInt(p, "timeoutMs") ?? 20_000)
  guard FileManager.default.fileExists(atPath: path) else {
    throw HelperError(code: Codes.notFound, kind: "notFound", message: "There's no file at that path.")
  }
  let iconOk = optBool(p, "allowIcon") ?? false
  let types: QLThumbnailGenerator.Request.RepresentationTypes = iconOk ? .all : [.lowQualityThumbnail, .thumbnail]
  let req = QLThumbnailGenerator.Request(
    fileAt: URL(fileURLWithPath: path), size: CGSize(width: size, height: size), scale: 1, representationTypes: types)
  let box = ThumbBox()
  let done = DispatchSemaphore(value: 0)
  QLThumbnailGenerator.shared.generateBestRepresentation(for: req) { rep, err in
    if let rep {
      box.image = rep.cgImage
      switch rep.type {
      case .icon: box.type = "icon"
      case .lowQualityThumbnail: box.type = "lowQualityThumbnail"
      case .thumbnail: box.type = "thumbnail"
      @unknown default: box.type = "unknown"
      }
    } else {
      box.error = err?.localizedDescription
    }
    done.signal()
  }
  if done.wait(timeout: .now() + .milliseconds(timeoutMs)) == .timedOut {
    QLThumbnailGenerator.shared.cancel(req)
    throw HelperError(code: Codes.timeout, kind: "timeout", message: "The preview took too long to draw, so it was skipped.")
  }
  guard let image = box.image else {
    throw HelperError(code: Codes.failed, kind: "failed", message: "macOS couldn't draw a preview of that file.", data: box.error.map { ["reason": $0] } ?? [:])
  }
  let data = NSMutableData()
  guard let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
    throw HelperError(code: Codes.failed, kind: "failed", message: "The preview couldn't be saved as a picture.")
  }
  CGImageDestinationAddImage(dest, image, nil)
  guard CGImageDestinationFinalize(dest) else {
    throw HelperError(code: Codes.failed, kind: "failed", message: "The preview couldn't be saved as a picture.")
  }
  return [
    "png": (data as Data).base64EncodedString(), "width": image.width, "height": image.height, "type": box.type,
  ]
}
