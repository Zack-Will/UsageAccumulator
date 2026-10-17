# @ua/menubar-mac

macOS 菜单栏外壳。取代 `apps/menubar`（Electron，242MB）。

## 分工

Swift 只做 macOS 原生才能做的事：`NSStatusItem`、`WKWebView` 面板、监管探针子进程。
**数据逻辑一行都不在这里** —— JSONL 解析、去重、定价、投影、标定全部留在 `@ua/core` /
`@ua/probe`（TS），Linux 探针复用同一套代码。两份实现会在跨机去重上悄悄分歧，
而那种分歧不会报错，只会给出两个都很像样但对不上的数字。

面板本体是 WKWebView 加载 `apps/menubar/src/renderer/` 那套 HTML —— 与 Electron 版
**同一份文件**，配色走 `@ua/tokens`。改一次两边都生效。

```
UsageAccumulator.app
├─ Contents/MacOS/UsageAccumulator        Swift 外壳
├─ Contents/PlugIns/UsageWidget.appex     桌面小部件（见下）
└─ Contents/Resources/
   ├─ renderer/                           index.html / panel.css / panel.js / theme.css
   └─ probe-launch.json                   探针启动参数（构建时按仓库路径生成）
```

## 构建

```bash
./build.sh          # 产出 build/UsageAccumulator.app，含 ad-hoc 签名
open build/UsageAccumulator.app
```

不用 `.xcodeproj`：`swiftc` + 手写 `Info.plist` 就够，也省掉工程文件在仓库里的无谓 diff。

## 桌面小部件

小、中、大三档，在桌面右键「编辑小部件」里找「UsageAccumulator」。点一下弹出菜单栏面板。

| 档 | 内容 |
|---|---|
| 小 | 一张卡：最先耗尽的窗口，都不会耗尽时取用量最高的 |
| 中 | 5h / 7d 两张卡并排 |
| 大 | 两张完整额度卡（倒计时、速度、重置、已用 / 满额约、调用次数、非 Code 占比）+ 其余窗口（7d Fable 等）+ 两栏按模型的花费 |

小部件的实际尺寸随屏幕而变（同是大档，有的 Mac 上 364×382，有的只有 344×344）。四周固定留 18pt，
每档按实际高度从信息最全的版本往下试，放不下就依次省掉金额行、模型明细、倒计时与速度，不会溢出裁切。

小、中两档照搬安卓小部件，大档是 Mac 独有的；规则逐条对齐看板额度卡（`apps/web/src/components/WindowCards.tsx`），
见 `Widget/QuotaModel.swift`。字体是看板同一个 Source Serif 4 文件（`Resources/Fonts/`，SIL OFL 1.1），中文回退 Songti SC。

**数据通道**：菜单栏每次轮询后写 `~/Library/Application Support/UsageAccumulator/Widget/snapshot.json`，
小部件只读它，不联网、不碰凭证。不用 App Group：那要开发者证书，ad-hoc 签名下系统直接拒绝写入。
小部件扩展必须开沙箱，靠临时例外只读 `Widget/` 这一个子目录 —— 读不到隔壁存着 token 的 `mac.json`。

金额与窗口细节要多打 `/v1/windows/current` 和每个窗口一次 `/v1/distribution`，5 分钟取一次，窗口换代时立刻重取。

**刷新**：小部件的时间线每分钟一帧，倒计时、时间刻度、「已停止更新」自己会走。菜单栏只在状态变化
（出错 / 恢复 / 换色 / 会不会耗尽）时立刻点名重画，数字变化至少隔 10 分钟一次 —— 系统给后台 App 的重画次数有日预算，
用完之后的点名会被静默丢掉。菜单栏退出后，超过 3 个轮询周期（至少 5 分钟）没写快照，数字降成灰色并写「已停止更新」。

**设计预览**：`./scripts/preview-widget.sh` 用假数据把各种状态 × 三档 × 深浅色画到 `build/widget-preview/`，不用往桌面上加。

## 凭证

菜单栏只认一样东西：服务端的 `UA_DASHBOARD_TOKEN`，在面板设置里填，存在
`~/Library/Application Support/UsageAccumulator/mac.json`（0600），不进日志、不发给渲染层。

**不碰 claude.ai 凭证。** 额度由服务端直接抓（ARCHITECTURE §5.3），会话在看板顶栏「额度更新」里交给服务端；
菜单栏只从服务端拿汇总好的数字。早先的「登录 Claude」窗口、Keychain 存取、给探针注入
`UA_PROBE_CLAUDE_SESSION_KEY` 都已删除（2026-10-08）。

## 探针监管

`superviseProbe`（`~/Library/Application Support/UsageAccumulator/mac.json`）控制是否由本
App 拉起 Node 探针。**launchd 里已有 `com.zackwill.ua-probe` 时必须保持 false**，
否则两个探针会抢同一个 `state.db`。

迁移到本 App 托管时：先卸载 launchd agent，再把 `superviseProbe` 置 true。

退出 App = 采集停止。这是刻意的语义：探针靠游标续传，下次打开会把期间的记录整批补上。

## 已知问题

- **本机代理会让公网地址连不上。** 系统代理（127.0.0.1:7897）对 `ccusage.zackwill.space`
  会给 TLS 失败，URLSession 走系统代理所以受影响；探针在 launchd 下没有代理环境变量，直连所以正常。
  需要在代理规则里给 `*.zackwill.space` 加直连，或改用内网地址。
- 未做公证。首次打开若被 Gatekeeper 拦，`xattr -dr com.apple.quarantine build/UsageAccumulator.app`。
