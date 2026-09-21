import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// 菜单栏应用：不进 Dock、不抢焦点（Info.plist 里的 LSUIElement 也写了一份）
app.setActivationPolicy(.accessory)
app.run()
