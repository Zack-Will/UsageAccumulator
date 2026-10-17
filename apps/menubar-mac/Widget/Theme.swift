/**
 * 配色与字体。颜色取自 apps/web/src/styles/claude.css（与安卓 res/values/colors.xml 与 values-night 同一组值），
 * 改那边时同步这里。
 *
 * 字体照看板的 --font-display：Source Serif 4（看板打包的同一个可变字体文件，带字重和视觉字号两个轴），
 * 中文回退到 Songti SC —— 看板在 Mac 上的中文也正是落到它。小部件整套衬线，与安卓小部件一致。
 */
import CoreText
import SwiftUI

struct Palette {
    var surface: Color
    var border: Color
    var track: Color
    var text: Color
    var text2: Color
    var text3: Color
    var ok: Color
    var warn: Color
    var danger: Color
    var okG: Color
    var warnG: Color
    var dangerG: Color
    var mutedG: Color
    var pace: Color

    static let light = Palette(
        surface: Color(hex: 0xFFFFFF), border: Color(hex: 0xE8E6DC), track: Color(hex: 0xF0EEE6),
        text: Color(hex: 0x141413), text2: Color(hex: 0x3D3D3A), text3: Color(hex: 0x5E5D59),
        ok: Color(hex: 0x566B3E), warn: Color(hex: 0x96590F), danger: Color(hex: 0xAE3F35),
        okG: Color(hex: 0x6F8752), warnG: Color(hex: 0xB87330), dangerG: Color(hex: 0xC8553F),
        mutedG: Color(hex: 0x73726C), pace: Color(hex: 0x141413).opacity(0.55)
    )

    static let dark = Palette(
        surface: Color(hex: 0x262624), border: Color(hex: 0x393834), track: Color(hex: 0x383733),
        text: Color(hex: 0xF5F4EE), text2: Color(hex: 0xCFCCC2), text3: Color(hex: 0xA6A399),
        ok: Color(hex: 0xA9BE8C), warn: Color(hex: 0xE6B46F), danger: Color(hex: 0xEF8F82),
        okG: Color(hex: 0x93AC70), warnG: Color(hex: 0xE39A4F), dangerG: Color(hex: 0xE26A55),
        mutedG: Color(hex: 0x8F8C83), pace: Color(hex: 0xF5F4EE).opacity(0.55)
    )

    static func of(_ scheme: ColorScheme) -> Palette { scheme == .dark ? .dark : .light }

    /// 文字色：ok 用正文色，warn / danger 才上色（看板 Num 的规则）
    func text(_ tone: Tone) -> Color {
        switch tone {
        case .ok: return text
        case .warn: return warn
        case .danger: return danger
        case .muted: return text3
        }
    }

    /// 额度条实心段
    func bar(_ tone: Tone) -> Color {
        switch tone {
        case .ok: return okG
        case .warn: return warnG
        case .danger: return dangerG
        case .muted: return mutedG
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

enum UAFont {
    /// 进程内注册一次。小部件扩展从自己的 Resources/Fonts 找；预览工具用 UA_FONT_DIR 指过来
    private static let registered: Bool = {
        let dir = ProcessInfo.processInfo.environment["UA_FONT_DIR"].map { URL(fileURLWithPath: $0) }
            ?? Bundle.main.resourceURL?.appendingPathComponent("Fonts")
        guard let url = dir?.appendingPathComponent("SourceSerif4.woff2") else { return false }
        return CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }()

    private static let wght = 0x7767_6874 // 'wght'
    private static let opsz = 0x6F70_737A // 'opsz'

    /**
     * 衬线字。weight 是可变字体的字重轴（看板：大数字 440、标题 600、正文 400），
     * 视觉字号跟着字号走，等同于浏览器的 font-optical-sizing: auto。
     */
    static func serif(_ size: CGFloat, weight: CGFloat = 400) -> Font {
        _ = registered
        let cjk = CTFontDescriptorCreateWithNameAndSize((weight >= 600 ? "STSongti-SC-Bold" : "STSongti-SC-Regular") as CFString, size)
        let attrs: [CFString: Any] = [
            kCTFontFamilyNameAttribute: "Source Serif 4",
            kCTFontVariationAttribute: [wght: weight, opsz: min(60, max(8, size))],
            // Source Serif 的子集里没有 ≥ 这类符号：先让 Georgia 接住，宋体里的 ≥ 是斜的
            kCTFontCascadeListAttribute: [CTFontDescriptorCreateWithNameAndSize("Georgia" as CFString, size), cjk],
        ]
        let desc = CTFontDescriptorCreateWithAttributes(attrs as CFDictionary)
        return Font(CTFontCreateWithFontDescriptor(desc, size, nil))
    }
}

/// 字号（pt）。与看板 claude.css 对应：.card__title 13 · .num--xl 46（小部件里收到 40）· .quota__eta 13
struct TypeScale {
    var title: CGFloat
    var status: CGFloat
    var num: CGFloat
    var projLabel: CGFloat
    var proj: CGFloat
    var eta: CGFloat
    var moneyLabel: CGFloat
    var money: CGFloat
    var bar: CGFloat
    var tick: CGFloat

    static let card = TypeScale(title: 13, status: 12, num: 40, projLabel: 12, proj: 15, eta: 13, moneyLabel: 11, money: 14, bar: 8, tick: 14)
    static let list = TypeScale(title: 12, status: 12, num: 18, projLabel: 11, proj: 12, eta: 12, moneyLabel: 11, money: 12, bar: 6, tick: 11)
}
