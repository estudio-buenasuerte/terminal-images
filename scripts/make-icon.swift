import AppKit

// Renders the terminal-images plugin icon: an ASCII flower glowing on a
// monitor, on a near-black rounded tile. Writes one 1024 px master per
// variant plus a contact sheet. The plugin directory reads a square PNG,
// 512 to 2048 px, under 2 MB.
// Usage: swiftc scripts/make-icon.swift -o /tmp/make-icon && /tmp/make-icon <out-dir> [mono-family]

let outDir = CommandLine.arguments[1]
let monoFamily = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "Menlo-Bold"
try! FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
let side: CGFloat = 1024

func bitmap(_ w: CGFloat, _ h: CGFloat) -> NSBitmapImageRep {
    NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(w), pixelsHigh: Int(h),
                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
}

func monoFont(_ size: CGFloat) -> NSFont {
    NSFont(name: monoFamily, size: size) ?? NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
}

let flower = [
    "    _    ",
    "  _(_)_  ",
    " (_)@(_) ",
    "   (_)   ",
    "    |    ",
    "  \\ | /  ",
    "   \\|/   ",
    "    |    ",
]

struct Variant {
    let name: String
    let ink: NSColor          // the phosphor
    let glow: CGFloat         // blur radius of the glow behind the glyphs
    let scan: CGFloat         // scanline strength on the screen, 0 to 1
    let bezel: NSColor
}

func draw(_ v: Variant) -> NSBitmapImageRep {
    let rep = bitmap(side, side)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext

    // Tile: near-black squircle with a faint rim, a trace of blue so the PNG stays RGB.
    let inset: CGFloat = 60
    let tileRect = NSRect(x: inset, y: inset, width: side - inset * 2, height: side - inset * 2)
    let tile = NSBezierPath(roundedRect: tileRect, xRadius: 200, yRadius: 200)
    NSGradient(starting: NSColor(calibratedRed: 0.11, green: 0.115, blue: 0.13, alpha: 1),
               ending: NSColor(calibratedRed: 0.03, green: 0.033, blue: 0.04, alpha: 1))!.draw(in: tile, angle: -90)
    NSColor(calibratedWhite: 1, alpha: 0.18).setStroke(); tile.lineWidth = 6; tile.stroke()
    tile.addClip()

    // Monitor: bezel, screen, neck and foot, centred a little above the middle.
    let screenW: CGFloat = 620, screenH: CGFloat = 520
    let bezelPad: CGFloat = 34
    let cx = side / 2, cy = side / 2 + 48
    let screen = NSRect(x: cx - screenW / 2, y: cy - screenH / 2, width: screenW, height: screenH)
    let bezelRect = screen.insetBy(dx: -bezelPad, dy: -bezelPad)
    let bezel = NSBezierPath(roundedRect: bezelRect, xRadius: 44, yRadius: 44)
    v.bezel.setFill(); bezel.fill()
    NSColor(calibratedWhite: 1, alpha: 0.55).setStroke(); bezel.lineWidth = 8; bezel.stroke()

    let neck = NSRect(x: cx - 60, y: bezelRect.minY - 70, width: 120, height: 70)
    v.bezel.setFill(); neck.fill()
    let foot = NSBezierPath(roundedRect: NSRect(x: cx - 170, y: neck.minY - 26, width: 340, height: 26), xRadius: 13, yRadius: 13)
    foot.fill()
    NSColor(calibratedWhite: 1, alpha: 0.45).setStroke(); foot.lineWidth = 6; foot.stroke()

    let screenPath = NSBezierPath(roundedRect: screen, xRadius: 18, yRadius: 18)
    NSColor(calibratedRed: 0.015, green: 0.02, blue: 0.02, alpha: 1).setFill(); screenPath.fill()

    ctx.saveGState()
    screenPath.addClip()

    // Scanlines: every fourth row a shade darker, the old tube look.
    if v.scan > 0 {
        NSColor(calibratedWhite: 0, alpha: v.scan).setFill()
        var y = screen.minY
        while y < screen.maxY { NSRect(x: screen.minX, y: y, width: screen.width, height: 2).fill(); y += 6 }
    }

    // The flower, sized by its ink rather than its font metrics so it fills the
    // screen the same way whatever the typeface's line height: measure once at a
    // reference size, scale to the screen, then centre the ink.
    let ratio: CGFloat = 1.1
    func ink(_ size: CGFloat) -> (lines: [CTLine], box: CGRect) {
        let f = monoFont(size)
        var lines: [CTLine] = []
        var box = CGRect.null
        for (i, line) in flower.enumerated() {
            let a = NSAttributedString(string: line, attributes: [.font: f, .foregroundColor: v.ink])
            let ct = CTLineCreateWithAttributedString(a)
            lines.append(ct)
            let b = CTLineGetImageBounds(ct, ctx).offsetBy(dx: 0, dy: -CGFloat(i) * size * ratio)
            box = box.union(b)
        }
        return (lines, box)
    }
    let probe = ink(100).box
    let fill: CGFloat = 0.9
    let fontSize = floor(100 * min(screen.width * fill / probe.width, screen.height * fill / probe.height))
    let (lines, box) = ink(fontSize)
    let origin = CGPoint(x: screen.midX - box.midX, y: screen.midY - box.midY)
    for (i, ct) in lines.enumerated() {
        ctx.saveGState()
        if v.glow > 0 { ctx.setShadow(offset: .zero, blur: v.glow, color: v.ink.withAlphaComponent(0.9).cgColor) }
        ctx.textPosition = CGPoint(x: origin.x, y: origin.y - CGFloat(i) * fontSize * ratio)
        CTLineDraw(ct, ctx)
        ctx.restoreGState()
    }
    ctx.restoreGState()

    NSGraphicsContext.restoreGraphicsState()
    return rep
}

let variants = [
    Variant(name: "A-phosphor-green", ink: NSColor(calibratedRed: 0.55, green: 1.0, blue: 0.6, alpha: 1), glow: 22, scan: 0.35, bezel: NSColor(calibratedWhite: 0.16, alpha: 1)),
    Variant(name: "B-white", ink: NSColor(calibratedWhite: 0.96, alpha: 1), glow: 20, scan: 0.35, bezel: NSColor(calibratedWhite: 0.16, alpha: 1)),
    Variant(name: "C-amber", ink: NSColor(calibratedRed: 1.0, green: 0.72, blue: 0.3, alpha: 1), glow: 22, scan: 0.35, bezel: NSColor(calibratedWhite: 0.16, alpha: 1)),
    Variant(name: "D-white-flat", ink: NSColor(calibratedWhite: 0.96, alpha: 1), glow: 0, scan: 0, bezel: NSColor(calibratedWhite: 0.12, alpha: 1)),
]

var reps: [NSBitmapImageRep] = []
for v in variants {
    let rep = draw(v)
    reps.append(rep)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(outDir)/\(v.name).png"))
}

// Contact sheet: the variants in a row at 512 px, labelled.
let cell: CGFloat = 512
let sheet = bitmap(cell * CGFloat(reps.count), cell + 60)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: sheet)
NSColor(calibratedWhite: 0.5, alpha: 1).setFill(); NSRect(x: 0, y: 0, width: sheet.pixelsWide, height: sheet.pixelsHigh).fill()
for (i, rep) in reps.enumerated() {
    let img = NSImage(size: NSSize(width: side, height: side)); img.addRepresentation(rep)
    img.draw(in: NSRect(x: CGFloat(i) * cell, y: 60, width: cell, height: cell))
    let label = NSAttributedString(string: variants[i].name, attributes: [.font: monoFont(22), .foregroundColor: NSColor.black])
    label.draw(at: NSPoint(x: CGFloat(i) * cell + 20, y: 18))
}
NSGraphicsContext.restoreGraphicsState()
try! sheet.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(outDir)/contact-sheet.png"))
print("wrote \(reps.count) variants and contact-sheet.png to \(outDir)")
