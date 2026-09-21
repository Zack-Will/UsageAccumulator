# @ua/menubar-mac

macOS 菜单栏外壳。取代 `apps/menubar`（Electron，242MB）。

## 分工

Swift 只做三件 macOS 原生才能做的事：`NSStatusItem`、`WKWebView` 登录、Keychain。
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

`登录 Claude`（菜单栏右键）弹出 WKWebView 打开 claude.ai。**用户自己登录**，
外壳不代填任何东西，也不绕过 Cloudflare —— 需要真浏览器引擎正是因为登录页本身要过挑战。

登录后从 `WKHTTPCookieStore` 读出 `sessionKey`（HttpOnly，页面脚本读不到，原生侧读得到），
写进 Keychain（service `ua-probe` / account `claude-session-key`）。

传给探针走**环境变量** `UA_PROBE_CLAUDE_SESSION_KEY`，不走 argv（argv 会出现在 `ps` 里）。
也刻意**不让** Node 用 `security` CLI 去读 Keychain —— 那会撞 ACL 授权弹窗，对后台进程是致命的。

配套地，探针的 `~/.config/ua-probe/config.toml` 要设 `credential = "env"`。

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
