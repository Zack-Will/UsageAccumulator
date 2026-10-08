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
