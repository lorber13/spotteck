
import Cocoa

let size = NSSize(width: 512, height: 512)
let image = NSImage(size: size)
image.lockFocus()

let ctx = NSGraphicsContext.current!.cgContext

// Dark chassis background rounded rect
let rect = NSRect(x: 16, y: 16, width: 480, height: 480)
let path = NSBezierPath(roundedRect: rect, xRadius: 104, yRadius: 104)
NSColor(calibratedRed: 0.08, green: 0.08, blue: 0.07, alpha: 1.0).setFill()
path.fill()

// Inner well circle (CRT Oscilloscope)
let circleRect = NSRect(x: 106, y: 106, width: 300, height: 300)
let circlePath = NSBezierPath(ovalIn: circleRect)
NSColor(calibratedRed: 0.0, green: 0.0, blue: 0.0, alpha: 1.0).setFill()
circlePath.fill()

// Bezel rim
NSColor(calibratedRed: 0.16, green: 0.16, blue: 0.15, alpha: 1.0).setStroke()
circlePath.lineWidth = 10
circlePath.stroke()

// Sinuous Orange Wave
ctx.setStrokeColor(red: 0.91, green: 0.31, blue: 0.12, alpha: 1.0)
ctx.setLineWidth(14)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)

ctx.beginPath()
for i in 0...100 {
    let t = Double(i) / 100.0
    let x = 120.0 + t * 272.0
    let env = pow(sin(t * Double.pi), 1.4)
    let y = 256.0 + sin(t * Double.pi * 3.2) * 58.0 * env
    if i == 0 {
        ctx.move(to: CGPoint(x: x, y: y))
    } else {
        ctx.addLine(to: CGPoint(x: x, y: y))
    }
}
ctx.strokePath()

image.unlockFocus()

if let tiffData = image.tiffRepresentation,
   let bitmap = NSBitmapImageRep(data: tiffData),
   let pngData = bitmap.representation(using: .png, properties: [:]) {
    try? pngData.write(to: URL(fileURLWithPath: "build/icon.png"))
}
