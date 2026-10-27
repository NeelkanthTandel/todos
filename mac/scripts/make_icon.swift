import AppKit

// Renders the 1024×1024 app icon: the site's favicon (three rising bars in the "boiling over" red) on a
// paper-white tile. Everything is drawn here, so no third-party artwork ends up in the icon.
//
// Usage: swift scripts/make_icon.swift out.png

let out = CommandLine.arguments[1]
let size: CGFloat = 1024

func color(_ hex: UInt32) -> NSColor {
    NSColor(
        srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
        blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
}

let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { _ in
    // Tile: Apple's icon grid leaves a 100 pt margin around an 824 pt rounded square.
    let tile = NSBezierPath(roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824), xRadius: 186, yRadius: 186)
    NSGradient(colors: [color(0xFFFFFF), color(0xF3F4F7)], atLocations: [0, 1], colorSpace: .sRGB)!.draw(in: tile, angle: -90)

    // The favicon is a 14×13 grid: bars 3.4 wide at x = 0, 5, 10, heights 5, 9, 13, radius 1.
    let unit: CGFloat = 36, left = 512 - 7 * unit, bottom = 512 - 6.5 * unit
    color(0xD6451B).setFill()
    for (x, h) in [(0.0, 5.0), (5.0, 9.0), (10.0, 13.0)] {
        let bar = NSRect(x: left + x * unit, y: bottom, width: 3.4 * unit, height: h * unit)
        NSBezierPath(roundedRect: bar, xRadius: unit, yRadius: unit).fill()
    }
    return true
}

let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
    isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
