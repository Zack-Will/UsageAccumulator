# apps/android

安卓外壳 + 桌面小部件。主要目标机型是小米 HyperOS。

## 分工

外壳**不打包任何前端产物**：WebView 直接加载服务端托管的看板（同源，会话 Cookie 由 WebView 保管）。
网页端一部署，App 下次打开就是新 UI，外壳本身几乎不用跟着发版。服务端静态资源是
`Cache-Control: public, max-age=0` + ETag，每次打开都会重新校验，不存在「手机上还是旧版」的问题。

原生侧只做网页做不了的事：

| 原生 | 为什么不放网页 |
|---|---|
| 首次启动填服务器地址、设置页 | WebView 还没有地址可加载 |
| 连不上时的错误页 | 页面本身就打不开 |
| 桌面小部件 | 运行在 WebView 之外 |

与网页的约定见 `docs/CONTRACT.md` §2.2a，网页侧实现在 `apps/web/src/app-bridge.ts`。

**零运行时依赖**：平台自带的 WebView / HttpURLConnection / org.json 就够。
小部件跑在小米要求的独立进程里（内存上限 35MB），依赖越少越稳。

## 小部件

视觉照搬看板的额度卡（`apps/web/src/components/WindowCards.tsx` + `styles/claude.css`）：
标题 · 衬线大数字 + 重置时预计 · 额度条（已用 / 预计 / 时间刻度）· 耗尽或重置时刻。
着色阈值、窗口过滤（去掉官方响应里的代号占位窗口）都与看板同一套规则，见 `widget/WidgetModel.kt`。
外框按小米设计规范：圆角 20dp、没有描边，和官方小部件放在一起时风格统一。

两种样式，都可以拖动改大小（最小 2×2，与官方小部件一样 `resizeMode=3`），按桌面报的实际尺寸选布局：

| | 窄（< 250dp，2 列） | 宽（≥ 250dp，4 列） |
|---|---|---|
| **卡片**（额度 / 额度 · 双卡） | 一张卡：最先耗尽的窗口，都不会耗尽时取用量最高的 | 5h / 7d 两张卡并排 |
| **列表**（额度 · 列表） | 每行两层：标题 + 数字，下面一整条额度条 | 每个窗口一行，右侧写耗尽或重置时刻 |

高度 ≥ 150dp 用宽松档，字号照看板原尺寸；更矮时用紧凑档，按小米最小尺寸 110dp 高排。
实测 HyperOS 4 桌面的 4×2 格子是 351×184dp。布局由 `scripts/gen-widget-layouts.py` 生成，**不要手改 XML**。

**所有文字都是位图，整套衬线**：小米会把系统主题字体（MiSans）强制套到小部件的所有文字上
（`ro.miui.ui.font.theme_apply=true`），`fontFamily` 声明的字体在真机上会被换成黑体，模拟器上却看不出来。
所以布局里没有 TextView，文字全由 `TextArt` 画成白色字形位图，颜色靠 ImageView 着色（给颜色资源 id），
深浅色仍由桌面自动切换。字体：
- 数字与拉丁字母：Source Serif 4（看板的 `--font-display`），大数字 440 字重，正文 400 / 标题 600
- 中文：思源宋体 Noto Serif SC，它的拉丁字形本就源自 Source Serif，放在一起风格一致；也正是看板 display 字体栈里中文的回退
- 子集外的字（比如服务端将来下发的新文案）回退到系统衬线字体，不会显示成方框

看板上只有大数字和页面标题是衬线、小字是无衬线的 Inter；小部件全用衬线，比看板更「书卷气」一点，这是有意的。

**加到桌面**：只能从 App 里加，路径是「设置 → 添加卡片小部件 / 添加列表小部件」（或长按桌面图标 →「设置」）。
小米的小部件选择器，包括其中的「安卓小部件」栏，只显示小米服务器清单里的条目，
没上架的应用会显示「正在努力适配中」。`miuiWidget` 声明由 `local.properties` 的 `UA_MIUI_WIDGET=true` 打开，
**过审前保持关闭**。曝光刷新（看到桌面就刷新）也要等过审后才有意义。

刷新来源：
- 系统定时，最短 30 分钟一次
- App 页面加载完、离开前台、改设置、App 升级后立即刷新
- 拖动改大小后按新尺寸重画

耗尽和重置一律写**绝对钟点**（「03:18 耗尽」），不写倒计时：小部件两次刷新之间隔着几十分钟，
「还剩 54 分钟」挂在桌面上很快就错了。也别用 `Chronometer`：HyperOS 桌面把它的 elapsedRealtime 基准
直接当成剩余时长，实测显示成「199:58:07 后耗尽」，199 小时正好是手机的开机时长。
拉取失败时沿用上次的数字，但会降成灰色并写明原因，不会清空或显示 0%。

宽松档卡片底部有看板同款的折算费用：「已用 $32.34 ｜ 满额约 $216」，算法照搬 `WindowCards.tsx`，见 `Money.kt`。
满额约 = 已用 ÷ 本地 Claude Code 吃掉的百分比，也就是这个窗口打满大约值多少钱（等价 API 费用，不是实际扣费）。
需要多发 1 + 2 个请求（`/v1/windows/current` 和每个窗口一次 `/v1/distribution`）；取不到时沿用上次的值，
再没有就写「—」，不影响额度数字本身。

凭证：优先用 WebView 登录后的会话 Cookie（外壳离开前台时抄一份给小部件）。
服务端没开密码登录时，在设置页填「访问 token」。

**字体子集**：`res/font/ua_*.ttf` 由 `scripts/gen-widget-fonts.py` 生成（SIL Open Font License 1.1，源文件来自 google/fonts）。
中文只收小部件会画的字：脚本会扫描 Kotlin 源码里字符串字面量中的汉字，目前 87 个字，每种字重约 26KB。**改了界面文案要重跑**：

```bash
pip install fonttools
python3 scripts/gen-widget-fonts.py --latin 'SourceSerif4[opsz,wght].ttf' --cjk 'NotoSerifSC[wght].ttf'
```

### 设计预览

debug 包里带一个预览页，用假数据把各种状态（正常 / 会耗尽 / 快耗尽 / 拉取失败 / 没有数据）并排画出来，
不用每次都往真机桌面上加：

```bash
./gradlew assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -S -n space.zackwill.ua/.WidgetPreviewActivity --es theme dark --es size spec
# theme = light | dark；size = spec（小米最小尺寸）| real（约 170 / 350×170dp）
```

## 构建与安装

需要 Android SDK（`local.properties` 的 `sdk.dir`）和 JDK 17+，Android Studio 自带的 JBR 就行。

```bash
cat > local.properties <<EOF
sdk.dir=$HOME/Library/Android/sdk
UA_DEFAULT_SERVER=https://你的域名     # 可选：首次启动时预填
EOF

export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew testDebugUnitTest          # 解析、地址规范化、小部件显示规则
./gradlew assembleRelease            # 用本机 debug 密钥签名，只装自己手机
adb install -r app/build/outputs/apk/release/app-release.apk
```

小米手机首次通过 adb 安装，要先在「开发者选项」里打开 **USB 安装**，并在手机上点允许。
