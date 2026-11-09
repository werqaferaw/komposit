// Renders Komposit's app icon into an .iconset folder: the 04.C solid tile from
// the logo spec (Ink #111111 tile, white arrow) on the macOS icon grid.
// Keep kompositTile in sync with the copy in Komposit.swift and brand/*.svg.
// usage: swift make-icon.swift <out.iconset>
import Cocoa

// The Komposit mark (04.C solid tile) drawn into `rect`: the rounded tile, and
// the arrow as a separate subpath so callers can fill it or knock it out.
func kompositTile(in rect: NSRect) -> (tile: NSBezierPath, arrow: NSBezierPath) {
  let k = rect.width / 140
  func pt(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: rect.minX + x * k, y: rect.maxY - y * k) }
  let tile = NSBezierPath(roundedRect: rect, xRadius: 32.083 * k, yRadius: 32.083 * k)
  let p = NSBezierPath()
  // 04.C arrow, in tile units (140 × 140, y down), from the Illustrator spec.
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

let out = URL(fileURLWithPath: CommandLine.arguments[1])
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func render(_ px: Int) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                             hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let s = CGFloat(px) / 1024
  // macOS icon grid: 824pt tile centred in 1024, with the system's soft drop shadow.
  let mark = kompositTile(in: NSRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s))
  NSGraphicsContext.saveGraphicsState()
  let shadow = NSShadow()
  shadow.shadowColor = NSColor(calibratedWhite: 0, alpha: 0.3)
  shadow.shadowOffset = NSSize(width: 0, height: -10 * s)
  shadow.shadowBlurRadius = 20 * s
  shadow.set()
  NSColor(srgbRed: 17 / 255, green: 17 / 255, blue: 17 / 255, alpha: 1).setFill()
  mark.tile.fill()
  NSGraphicsContext.restoreGraphicsState()
  NSColor.white.setFill()
  mark.arrow.fill()
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}

for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
                   ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
  try! render(px).write(to: out.appendingPathComponent("icon_\(name).png"))
}
print("wrote \(out.path)")
