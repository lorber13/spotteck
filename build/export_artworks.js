const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const PRESETS = [
  { name: '01_kronberg_bauhaus_circle', palette: ['#E8501E', '#1E1D1B', '#F2ECE1'], pattern: 'bauhaus-circle' },
  { name: '02_kling_klang_bars', palette: ['#C8321E', '#181816', '#EAE4D7'], pattern: 'kraftwerk-bars' },
  { name: '03_tokyo_horizon_sun', palette: ['#2D6A4F', '#1B2A22', '#E9E5DA'], pattern: 'horizon-sun' },
  { name: '04_van_gelder_split', palette: ['#1D4E68', '#141B21', '#EBE7DD'], pattern: 'bluenote-split' },
  { name: '05_ambient_radar_arcs', palette: ['#D48C1C', '#24211C', '#F2EDE2'], pattern: 'radar-arcs' },
  { name: '06_selected_checker_minimal', palette: ['#3A5A40', '#DAD7CD', '#1B1B19'], pattern: 'checker-minimal' },
  { name: '07_oxford_diagonal_beam', palette: ['#B53826', '#E8E2D5', '#1F1E1B'], pattern: 'diagonal-beam' },
  { name: '08_paris_concentric_rings', palette: ['#2B4C59', '#D9D3C7', '#1C1B19'], pattern: 'concentric-rings' },
  { name: '09_ecm_vertical_stems', palette: ['#8C5A2B', '#211E1A', '#EDE8DC'], pattern: 'vertical-stems' }
];

const swiftScript = `
import Cocoa

func hexToColor(_ hex: String) -> NSColor {
    var hexSanitized = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    hexSanitized = hexSanitized.replacingOccurrences(of: "#", with: "")
    var rgb: UInt64 = 0
    Scanner(string: hexSanitized).scanHexInt64(&rgb)
    let r = CGFloat((rgb & 0xFF0000) >> 16) / 255.0
    let g = CGFloat((rgb & 0x00FF00) >> 8) / 255.0
    let b = CGFloat(rgb & 0x0000FF) / 255.0
    return NSColor(calibratedRed: r, green: g, blue: b, alpha: 1.0)
}

func renderArt(name: String, c1Hex: String, c2Hex: String, c3Hex: String, pattern: String) {
    let size = NSSize(width: 1024, height: 1024)
    let image = NSImage(size: size)
    image.lockFocus()

    let c1 = hexToColor(c1Hex)
    let c2 = hexToColor(c2Hex)
    let c3 = hexToColor(c3Hex)

    // Base background
    c3.setFill()
    NSRect(x: 0, y: 0, width: 1024, height: 1024).fill()

    switch pattern {
    case "bauhaus-circle":
        c2.setFill()
        let b1 = NSBezierPath(ovalIn: NSRect(x: 120, y: 120, width: 784, height: 784))
        b1.fill()
        c1.setFill()
        let b2 = NSBezierPath(ovalIn: NSRect(x: 420, y: 460, width: 410, height: 410))
        b2.fill()
    case "kraftwerk-bars":
        c2.setFill()
        NSRect(x: 0, y: 0, width: 1024, height: 1024).fill()
        c1.setFill()
        for x in stride(from: 140, to: 880, by: 180) {
            NSRect(x: CGFloat(x), y: 150, width: 100, height: 724).fill()
        }
    case "horizon-sun":
        c1.setFill()
        let s = NSBezierPath(ovalIn: NSRect(x: 256, y: 450, width: 512, height: 512))
        s.fill()
        c2.setFill()
        NSRect(x: 0, y: 0, width: 1024, height: 512).fill()
    case "bluenote-split":
        c2.setFill()
        NSRect(x: 0, y: 0, width: 650, height: 1024).fill()
        c1.setFill()
        NSRect(x: 650, y: 0, width: 374, height: 1024).fill()
        c3.setFill()
        NSRect(x: 150, y: 200, width: 350, height: 80).fill()
    case "radar-arcs":
        c2.setFill()
        NSRect(x: 0, y: 0, width: 1024, height: 1024).fill()
        c1.setStroke()
        for r in stride(from: 180, through: 420, by: 120) {
            let a = NSBezierPath()
            a.lineWidth = 60
            a.appendArc(withCenter: CGPoint(x: 512, y: 512), radius: CGFloat(r), startAngle: -20, endAngle: 220)
            a.stroke()
        }
    case "checker-minimal":
        c1.setFill()
        NSRect(x: 0, y: 512, width: 512, height: 512).fill()
        c2.setFill()
        NSRect(x: 512, y: 0, width: 512, height: 512).fill()
    case "diagonal-beam":
        c2.setFill()
        NSRect(x: 0, y: 0, width: 1024, height: 1024).fill()
        c1.setFill()
        let d = NSBezierPath()
        d.move(to: CGPoint(x: 0, y: 768))
        d.line(to: CGPoint(x: 768, y: 0))
        d.line(to: CGPoint(x: 1024, y: 0))
        d.line(to: CGPoint(x: 1024, y: 256))
        d.line(to: CGPoint(x: 256, y: 1024))
        d.line(to: CGPoint(x: 0, y: 1024))
        d.close()
        d.fill()
    case "concentric-rings":
        c2.setFill()
        NSRect(x: 0, y: 0, width: 1024, height: 1024).fill()
        c3.setStroke()
        let r1 = NSBezierPath(ovalIn: NSRect(x: 160, y: 160, width: 704, height: 704))
        r1.lineWidth = 40
        r1.stroke()
        c1.setFill()
        let r2 = NSBezierPath(ovalIn: NSRect(x: 350, y: 350, width: 324, height: 324))
        r2.fill()
    case "vertical-stems":
        c2.setFill()
        NSRect(x: 180, y: 0, width: 160, height: 750).fill()
        NSRect(x: 680, y: 250, width: 160, height: 750).fill()
        c1.setFill()
        NSRect(x: 430, y: 150, width: 160, height: 720).fill()
    default:
        break
    }

    image.unlockFocus()
    if let tiff = image.tiffRepresentation,
       let rep = NSBitmapImageRep(data: tiff),
       let png = rep.representation(using: .png, properties: [:]) {
        try? png.write(to: URL(fileURLWithPath: "artwork_presets/\\(name).png"))
    }
}

let presets: [(String, String, String, String, String)] = [
  ("01_kronberg_bauhaus_circle", "#E8501E", "#1E1D1B", "#F2ECE1", "bauhaus-circle"),
  ("02_kling_klang_bars", "#C8321E", "#181816", "#EAE4D7", "kraftwerk-bars"),
  ("03_tokyo_horizon_sun", "#2D6A4F", "#1B2A22", "#E9E5DA", "horizon-sun"),
  ("04_van_gelder_split", "#1D4E68", "#141B21", "#EBE7DD", "bluenote-split"),
  ("05_ambient_radar_arcs", "#D48C1C", "#24211C", "#F2EDE2", "radar-arcs"),
  ("06_selected_checker_minimal", "#3A5A40", "#DAD7CD", "#1B1B19", "checker-minimal"),
  ("07_oxford_diagonal_beam", "#B53826", "#E8E2D5", "#1F1E1B", "diagonal-beam"),
  ("08_paris_concentric_rings", "#2B4C59", "#D9D3C7", "#1C1B19", "concentric-rings"),
  ("09_ecm_vertical_stems", "#8C5A2B", "#211E1A", "#EDE8DC", "vertical-stems")
]

for p in presets {
    renderArt(name: p.0, c1Hex: p.1, c2Hex: p.2, c3Hex: p.3, pattern: p.4)
    print("Rendered: \\(p.0).png")
}
`;

fs.writeFileSync('build/export_artworks.swift', swiftScript);
execSync('swift build/export_artworks.swift');
console.log('All preset artworks exported successfully in 1024x1024 PNG!');
