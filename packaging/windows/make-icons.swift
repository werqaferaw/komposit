// Renders Komposit's Windows icons from the 04.C solid tile (the same geometry
// as packaging/macos/make-icon.swift and brand/*.svg; keep them in sync):
//   komposit.ico    Ink tile, white arrow: the app, installer and Start menu icon
//   tray-dark.ico   Ink tile, arrow knocked out: the tray icon on a light taskbar
//   tray-light.ico  Paper tile, arrow knocked out: the tray icon on a dark taskbar
// Sizes 16-256. Frames under 256 px are 32-bit DIBs (straight alpha), which
// every Windows and .NET's Icon class read; 256 px is PNG, as Windows expects.
// usage: swift make-icons.swift <out-dir>
import Cocoa

func kompositTile(in rect: NSRect) -> (tile: NSBezierPath, arrow: NSBezierPath) {
  let k = rect.width / 140
  func pt(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: rect.minX + x * k, y: rect.maxY - y * k) }
  let tile = NSBezierPath(roundedRect: rect, xRadius: 32.083 * k, yRadius: 32.083 * k)
  let p = NSBezierPath()
  p.move(to: pt(26.04, 57.207))
  p.curve(to: pt(26.906, 53.977), controlPoint1: pt(24.99, 56.156), controlPoint2: pt(25.47, 54.362))
  p.curve(to: pt(102.174, 33.809), controlPoint1: pt(26.906, 53.977), controlPoint2: pt(102.174, 33.809))
  p.curve(to: pt(106.517, 39.468), controlPoint1: pt(105.496, 32.919), controlPoint2: pt(108.236, 36.49))
  p.curve(to: pt(87.903, 71.707), controlPoint1: pt(106.517, 39.468), controlPoint2: pt(87.903, 71.707))
  p.curve(to: pt(87.731, 72.351), controlPoint1: pt(87.79, 71.903), controlPoint2: pt(87.731, 72.125))
  p.curve(to: pt(87.731, 109.577), controlPoint1: pt(87.731, 72.351), controlPoint2: pt(87.731, 109.577))
  p.curve(to: pt(81.141, 112.307), controlPoint1: pt(87.731, 113.017), controlPoint2: pt(83.573, 114.739))
  p.curve(to: pt(26.04, 57.207), controlPoint1: pt(81.141, 112.307), controlPoint2: pt(26.04, 57.207))
  p.close()
  return (tile, p)
}

enum Style { case solid, knockoutInk, knockoutPaper }

let ink = NSColor(srgbRed: 17 / 255, green: 17 / 255, blue: 17 / 255, alpha: 1)
let paper = NSColor(srgbRed: 244 / 255, green: 242 / 255, blue: 238 / 255, alpha: 1)

// RGBA (straight alpha), rows top to bottom.
func render(_ px: Int, _ style: Style) -> (rgba: [UInt8], png: Data) {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                             hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: px * 4, bitsPerPixel: 32)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  // A hair of margin so the tile's curve isn't clipped at small sizes.
  let m = max(0.5, CGFloat(px) / 64)
  let mark = kompositTile(in: NSRect(x: m, y: m, width: CGFloat(px) - 2 * m, height: CGFloat(px) - 2 * m))
  switch style {
  case .solid:
    ink.setFill(); mark.tile.fill()
    NSColor.white.setFill(); mark.arrow.fill()
  case .knockoutInk, .knockoutPaper:
    let p = mark.tile.copy() as! NSBezierPath
    p.append(mark.arrow)
    p.windingRule = .evenOdd
    (style == .knockoutInk ? ink : paper).setFill()
    p.fill()
  }
  NSGraphicsContext.restoreGraphicsState()
  // NSBitmapImageRep holds premultiplied alpha; ICO wants straight alpha.
  var out = [UInt8](repeating: 0, count: px * px * 4)
  let d = rep.bitmapData!
  for i in 0..<(px * px) {
    let a = Int(d[i * 4 + 3])
    for c in 0..<3 {
      let v = Int(d[i * 4 + c])
      out[i * 4 + c] = UInt8(a == 0 ? 0 : min(255, (v * 255 + a / 2) / a))
    }
    out[i * 4 + 3] = UInt8(a)
  }
  return (out, rep.representation(using: .png, properties: [:])!)
}

func le16(_ v: Int) -> [UInt8] { [UInt8(v & 0xff), UInt8((v >> 8) & 0xff)] }
func le32(_ v: Int) -> [UInt8] { [UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8((v >> 24) & 0xff)] }

// A 32-bit DIB frame: BITMAPINFOHEADER, BGRA rows bottom-up, then an all-zero
// AND mask (alpha does the masking).
func dib(_ px: Int, _ rgba: [UInt8]) -> [UInt8] {
  var b = [UInt8]()
  b += le32(40) + le32(px) + le32(px * 2) + le16(1) + le16(32) + le32(0) + le32(px * px * 4) + le32(0) + le32(0) + le32(0) + le32(0)
  for row in stride(from: px - 1, through: 0, by: -1) {
    for x in 0..<px {
      let i = (row * px + x) * 4
      b += [rgba[i + 2], rgba[i + 1], rgba[i], rgba[i + 3]]
    }
  }
  let maskRow = ((px + 31) / 32) * 4
  b += [UInt8](repeating: 0, count: maskRow * px)
  return b
}

func ico(_ style: Style, sizes: [Int]) -> Data {
  var frames = [(Int, [UInt8])]()
  for s in sizes {
    let r = render(s, style)
    frames.append((s, s >= 256 ? [UInt8](r.png) : dib(s, r.rgba)))
  }
  var head = le16(0) + le16(1) + le16(frames.count)
  var offset = 6 + 16 * frames.count
  var body = [UInt8]()
  for (s, data) in frames {
    head += [UInt8(s >= 256 ? 0 : s), UInt8(s >= 256 ? 0 : s), 0, 0] + le16(1) + le16(32) + le32(data.count) + le32(offset)
    offset += data.count
    body += data
  }
  return Data(head + body)
}

let out = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
let sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
try! ico(.solid, sizes: sizes).write(to: out.appendingPathComponent("komposit.ico"))
try! ico(.knockoutInk, sizes: sizes).write(to: out.appendingPathComponent("tray-dark.ico"))
try! ico(.knockoutPaper, sizes: sizes).write(to: out.appendingPathComponent("tray-light.ico"))
// A preview of each style for checking by eye.
for (name, st) in [("komposit", Style.solid), ("tray-dark", Style.knockoutInk), ("tray-light", Style.knockoutPaper)] {
  try! render(64, st).png.write(to: out.appendingPathComponent("preview-\(name)-64.png"))
}
print("wrote \(out.path)")
