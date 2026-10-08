#!/usr/bin/env swift
/**
 * 生成 Resources/AppIcon.icns。改了图形才需要重跑：
 *
 *   swift apps/menubar-mac/scripts/gen-icon.swift
 *
 * 图形与看板 favicon（apps/web/public/favicon.svg）、安卓启动图标同一套：
 * 陶土底 + 三根高低不一的柱子。坐标沿用那边的 60 单位画布（favicon 的 viewBox 24..84），
 * 按 macOS 图标网格放进 1024 画布中央 824 的圆角方块，四周留给阴影。
 */
import AppKit

let here = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
let resources = here.deletingLastPathComponent().appendingPathComponent("Resources")

let clay = NSColor(srgbRed: 0xD9 / 255, green: 0x77 / 255, blue: 0x57 / 255, alpha: 1)  // #D97757
let paper = NSColor(srgbRed: 0xFA / 255, green: 0xF9 / 255, blue: 0xF5 / 255, alpha: 1) // #FAF9F5

/// 画一张 px×px 的图标
func render(_ px: Int) -> Data {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext
    let k = CGFloat(px) / 1024

    // 圆角方块：824 见方，圆角与 favicon 同比例（14 / 60）
    let body: CGFloat = 824 * k
    let origin = (CGFloat(px) - body) / 2
    let u = body / 60  // favicon 的 1 个单位
    let bodyRect = CGRect(x: origin, y: origin, width: body, height: body)
    let bodyPath = CGPath(roundedRect: bodyRect, cornerWidth: 14 * u, cornerHeight: 14 * u, transform: nil)

    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10 * k), blur: 24 * k,
                  color: NSColor.black.withAlphaComponent(0.28).cgColor)
    ctx.addPath(bodyPath)
    ctx.setFillColor(clay.cgColor)
    ctx.fillPath()
    ctx.restoreGState()

    // 三根柱子：favicon 里 x = 10 / 24 / 38、宽 12，底边都在 50，高 16 / 28 / 40（y 向下）
    ctx.setFillColor(paper.cgColor)
    for (x, h) in [(10.0, 16.0), (24.0, 28.0), (38.0, 40.0)] {
        // CoreGraphics 的 y 向上：底边 50 → 离方块底部 10 个单位
        let r = CGRect(x: origin + CGFloat(x) * u, y: origin + 10 * u, width: 12 * u, height: CGFloat(h) * u)
        ctx.addPath(CGPath(roundedRect: r, cornerWidth: 2 * u, cornerHeight: 2 * u, transform: nil))
        ctx.fillPath()
    }

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("AppIcon.iconset")
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    try render(size).write(to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
    try render(size * 2).write(to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}

let out = resources.appendingPathComponent("AppIcon.icns")
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", iconset.path, "-o", out.path]
try p.run()
p.waitUntilExit()
guard p.terminationStatus == 0 else { fatalError("iconutil 失败") }
try? FileManager.default.removeItem(at: iconset)
print("✓ \(out.path)")
