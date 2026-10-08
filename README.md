# UsageAccumulator

把分散在多台机器上的 Claude Code 用量汇总到一个自建服务，再对照 claude.ai 官方的 5h / 7d 额度窗口，
告诉你**这个窗口会用到多少、什么时候耗尽、钱花在了哪**。

```
 Mac / Linux 机器                    自建服务端                         查看端
┌──────────────┐  gzip NDJSON   ┌────────────────────┐   HTTPS      ┌───────────────┐
│ ua-probe     │ ─────────────▶ │ ua-server          │ ◀─────────── │ Web 看板      │
│ 读 ~/.claude │  machine token │  + Postgres        │              │ Mac 菜单栏    │
└──────────────┘                │  + 托管看板静态文件 │              │ 安卓 App/小部件│
       × N 台                   │  + 每 5 分钟抓额度  │──▶ claude.ai └───────────────┘
                                └────────────────────┘
```

## 主要功能

- **跨机器汇总**：每台机器跑一个探针，增量读取 `~/.claude/projects/**/*.jsonl`，断网时本地排队、恢复后补传。
  通过 ssh 在远端跑的会话两边各留一份记录，服务端按 `(message_id, request_id)` 全局去重，不会重复计数。
- **只传元数据**：上报的只有 token 数、模型、项目、时间等维度，**不含任何 prompt、回复或工具参数**；
  可选把项目路径 HMAC 后再上报。
- **官方额度**：服务端 7×24 直接向 claude.ai 抓 5h / 7d 等窗口的已用百分比与重置时刻，不依赖某台笔记本开着。
- **预测与耗尽时刻**：按当前速率给出窗口结束时的预计用量、会不会打满、几点打满。
- **折算费用**：按 `deploy/pricing.json` 的官方单价（5m / 1h 缓存分开计价）算等价 API 费用，
  并反推「这个窗口打满大约值多少钱」。缺价的模型显示为未知，不按 0 算。
- **用量分布**：按机器、模型、项目、小时、归属方式拆分；窗口甘特图、燃尽曲线、周用量、标定结果。
- **多 profile**：官方订阅（按 claude.ai 组织区分，如个人 Max 与 team 分开记）与自定义 `base_url` 的 API 网关可以并存，
  窗口按 profile 独立计算。
- **多个查看端**：Web 看板（SSE 实时刷新）、macOS 菜单栏、安卓 App 与桌面小部件。

## 下载

| 组件 | 获取方式 |
|---|---|
| 探针 | `npm i -g https://github.com/Zack-Will/UsageAccumulator/releases/latest/download/ua-probe.tgz` |
| 服务端 + 看板 | `docker pull ghcr.io/zack-will/usage-accumulator`（amd64 / arm64） |
| macOS 菜单栏 | [Releases](https://github.com/Zack-Will/UsageAccumulator/releases) 里的 `UsageAccumulator-<版本>-macos.dmg` |
| 安卓 App | [Releases](https://github.com/Zack-Will/UsageAccumulator/releases) 里的 `UsageAccumulator-<版本>-android.apk` |

## 仓库结构

| 路径 | 内容 |
|---|---|
| `packages/ua-core` | 共享逻辑：JSONL 解析、去重、定价、窗口算法、标定。探针与服务端共用，保证两边数字一致 |
| `packages/ua-probe` | 探针 CLI：扫描、归属判定、本地队列、上报 |
| `packages/ua-server` | 服务端：Fastify + Postgres，聚合、预测、额度采样、托管看板 |
| `packages/ua-tokens` | 设计令牌（看板与菜单栏共用） |
| `apps/web` | Web 看板：React + Vite + ECharts |
| `apps/menubar-mac` | macOS 菜单栏（Swift 外壳 + WebView 面板） |
| `apps/menubar` | 旧版 Electron 菜单栏；面板的 HTML 仍由 Swift 版复用 |
| `apps/android` | 安卓外壳 + 桌面小部件 |
| `deploy/` | Docker Compose、Caddyfile、数据库迁移、定价表 |
| `docs/` | `ARCHITECTURE.md`（设计与指标定义）、`CONTRACT.md`（接口契约） |

## 准备

- Node.js ≥ 22（探针用到内置的 `node:sqlite`，建议 22.13 以上）
- pnpm 10（`corepack enable` 即可）
- Postgres 17 或 18（Docker 部署时自带）

```bash
pnpm install
pnpm test          # 全部单元测试
pnpm typecheck
```

---

## 一、部署服务端

### 1. 准备三类凭证

```bash
cp deploy/.env.example deploy/.env
openssl rand -hex 24   # → POSTGRES_PASSWORD
openssl rand -hex 32   # → UA_DASHBOARD_TOKEN
openssl rand -hex 32   # → UA_ENROLL_TOKEN
```

| 变量 | 给谁用 | 说明 |
|---|---|---|
| `UA_ENROLL_TOKEN` | 探针 | 一次性口令，探针安装时用它换取自己的长期 machine token |
| `UA_DASHBOARD_PASSWORD` | 浏览器、安卓 App | 看板登录密码，换来 30 天的 HttpOnly 会话 Cookie。留空则不开放密码登录。登录接口有退避限速，但仍请用强密码；改密码会让所有已登录设备下线 |
| `UA_DASHBOARD_TOKEN` | 菜单栏、脚本、安卓小部件（备用） | 单一 Bearer token，权限等同看板 |

`.env` 已被 `.gitignore` 忽略，**不要提交**。

<details>
<summary>其余可选环境变量</summary>

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | — | 必填（Compose 会自动拼） |
| `PORT` / `UA_HOST` | `8080` / `0.0.0.0` | 监听地址 |
| `UA_WEB_DIR` | 空 | 看板构建产物目录；空 = 只提供 API |
| `UA_PRICING_FILE` | `deploy/pricing.json` | 定价表 |
| `UA_QUOTA_SAMPLING` | `true` | 服务端直接抓 claude.ai 额度 |
| `UA_CLAUDE_SESSION_DIR` | `~/.config/ua-server/claude-sessions` | claude.ai 会话存放目录（0600 文件，不进数据库） |
| `UA_SESSION_TTL_MS` | 30 天 | 看板会话有效期 |
| `UA_DASHBOARD_URL` | 空 | 菜单栏「打开看板」跳转地址 |
| `UA_LOG_LEVEL` | `info` | 日志级别 |

完整列表见 `packages/ua-server/src/config.ts`。
</details>

### 2A. Docker Compose（推荐：Postgres + 服务端镜像 + Caddy 自动证书）

```bash
# deploy/.env 里填好 UA_DOMAIN、UA_ACME_EMAIL，域名解析到这台机器，开放 80/443
docker compose -f deploy/docker-compose.yml --env-file deploy/.env pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

服务端镜像来自 GHCR，自带看板和探针单文件（`/dl/ua-probe.mjs`）。`deploy/.env` 里的 `UA_VERSION` 可以固定版本，缺省 `latest`；
想从源码构建，把 `pull` 换成 `build`。升级就是重新 `pull` 再 `up -d`，数据库迁移在服务端启动时自动执行。

内网试跑可以叠加 `docker-compose.lan.yml`：server 直接暴露在 `8787`，不起 Caddy，明文 HTTP，仅限可信内网。

### 2B. 宿主机 Node 直接跑（从源码，适合开发或跑不了容器构建的机器）

```bash
# 只起 Postgres（映射到 127.0.0.1:5433），server/caddy 不用
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.lan.yml \
  --env-file deploy/.env up -d postgres

# 先打探针单文件，再构建看板：探针会被一起发布到 /dl/ua-probe.mjs，方便其他机器下载
pnpm -F @ua/probe bundle
pnpm -F @ua/web build

# 在仓库根目录启动（迁移按相对路径 deploy/migrations 查找，启动时自动执行）
set -a; source deploy/.env; set +a
DATABASE_URL="postgres://ua:${POSTGRES_PASSWORD}@127.0.0.1:5433/ua" \
UA_WEB_DIR="$PWD/apps/web/dist" PORT=8787 \
  pnpm -F @ua/server start
```

常驻建议用 systemd user service（记得 `loginctl enable-linger $USER`），并在前面套一层 HTTPS 反代。
**安卓 App 只接受 https 地址**，Caddy 的 SSE 与 ingest 配置可以照抄 `deploy/Caddyfile`。

### 3. 检查

```bash
curl https://ua.example.com/healthz     # → ok
```

---

## 二、配对教程：把各端连到服务端

整体顺序：**服务端 → 探针（产生用量） → 看板登录并交给服务端一份 claude.ai 会话（产生额度） → 菜单栏 / 手机**。

### 1. 探针：每台跑 Claude Code 的机器装一个

探针用 `UA_ENROLL_TOKEN` 换取这台机器专属的 machine token，之后只用后者上报；服务端只存它的哈希，可单独吊销。

**拿到探针**：

```bash
# 推荐。从 GitHub Release 装最新版，只依赖 Node ≥ 22.13
npm i -g https://github.com/Zack-Will/UsageAccumulator/releases/latest/download/ua-probe.tgz
```

<details>
<summary>其他方式：从自己的服务端下载 / 用仓库源码</summary>

```bash
# 从服务端下载单文件（Docker 镜像自带；源码部署需按 2B 先 bundle 再构建看板）
mkdir -p ~/.local/share/ua-probe && cd ~/.local/share/ua-probe
curl -fLO https://ua.example.com/dl/ua-probe.mjs
curl -fLO https://ua.example.com/dl/ua-probe.mjs.sha256 && shasum -a 256 -c ua-probe.mjs.sha256
alias ua-probe="node $PWD/ua-probe.mjs"

# 这台机器有仓库：直接用源码
alias ua-probe="$PWD/node_modules/.bin/tsx $PWD/packages/ua-probe/src/cli.ts"
```
</details>

不要用 `npx` 跑 `install`：常驻服务会记下探针所在路径，npx 缓存一清服务就起不来。
升级：重跑上面那条 `npm i -g`（链接始终指向最新版），再重启服务（macOS `launchctl kickstart -k gui/$(id -u)/com.ua.probe`，Linux `systemctl --user restart ua-probe`）。

**配对并导入历史**：

```bash
# ① enroll + 写配置，先不装服务
ua-probe install --server https://ua.example.com --enroll-token <UA_ENROLL_TOKEN> --no-service
#   → 写入 ~/.config/ua-probe/config.toml（0600，含 machine_token）

# ② 首次全量导入历史记录（限速上报，几百 MB 需要几分钟）
ua-probe backfill

# ③ 装成常驻服务：macOS → launchd，Linux → systemd user service
ua-probe install
loginctl enable-linger $USER     # 仅 Linux：否则 SSH 断开后探针会被杀

# 查看状态：队列深度、游标、归属时间线
ua-probe status
```

| 选项 | 说明 |
|---|---|
| `--profile <id>` | 默认 profile，缺省 `claude-official` |
| `--scan-root <path>` | 可重复；会话不在 `~/.claude/projects` 时用（比如改过 `CLAUDE_CONFIG_DIR`） |
| `--machine-token <t>` | 已有 token 时直接给，跳过 enroll |
| `--force` | 重写已有配置 |

日志：macOS 在 `~/Library/Logs/ua-probe/`，Linux 用 `journalctl --user -u ua-probe -f`。

**同一台机器只能跑一个探针**（共享 `~/.config/ua-probe/state.db`）。在 Mac 上如果改由菜单栏 App 托管探针，
先 `launchctl bootout gui/$(id -u)/com.ua.probe` 卸掉 launchd 服务。

**多个订阅 / 网关的归属**：在 `config.toml` 的 `[attribution]` 下配置映射，探针按 live 配置判定每条用量属于哪个 profile：

```toml
# ~/.claude.json 的 oauthAccount.organizationUuid → profile（切换订阅时账号不变、组织变）
[attribution.org_profiles]
"c702d391-…" = "claude-official"
"29c62b23-…" = "claude-team"

# ~/.claude/settings.json 的 env.ANTHROPIC_BASE_URL → profile（第三方网关）
[attribution.base_url_profiles]
"https://api.example-gateway.com" = "gw-example"
```

没配到的组织会自动归到 `claude-<组织前 8 位>`，不会混进已有 profile。其余字段见 `config.toml` 里的注释。

### 2. Web 看板

1. 浏览器打开 `https://ua.example.com`，输入 `UA_DASHBOARD_PASSWORD` 登录（没设密码时粘贴 `UA_DASHBOARD_TOKEN`，只存在本机浏览器）。
2. **交给服务端一份 claude.ai 会话**，额度数据从这里来：
   1. 在浏览器登录 claude.ai，打开开发者工具 → Application / 存储 → Cookies → `https://claude.ai`，复制 `sessionKey` 的值。
   2. 回到看板，点顶栏的「额度更新」（未配置时显示「未登录」），粘贴 `sessionKey` 保存。
      服务端会先拿它去问 claude.ai，认了才落盘，并立刻抓一次。
   3. 如果这个账号下有多个组织（比如个人订阅 + team），对话框会让你**选组织**：每个 profile 绑定一个组织。
      想同时看两份订阅，就在两个 profile 下各存一次同样的 `sessionKey`、各选各的组织。
3. 之后服务端每 5 分钟抓一次。顶栏状态含义：

| 顶栏显示 | 含义 | 处理 |
|---|---|---|
| 额度更新 | 正常 | — |
| 未登录 | 这个 profile 还没存会话 | 按上面步骤粘贴 `sessionKey` |
| 会话失效 | claude.ai 不认这个会话（退出登录、过期） | 重新复制一份 `sessionKey` |
| 被拦截 | 被 Cloudflare 质询 | 换会话没用，等退避结束或检查服务端出口网络 |
| 未选组织 | 会话有效但不知道抓哪个组织 | 在对话框里选组织 |

`sessionKey` 只存在服务端 `UA_CLAUDE_SESSION_DIR` 下的 0600 文件里，不进数据库，任何接口都不回显。

### 3. macOS 菜单栏

从 [Releases](https://github.com/Zack-Will/UsageAccumulator/releases) 下载 `UsageAccumulator-<版本>-macos.dmg`（Apple 芯片与 Intel 通用，需要 macOS 14+），
打开后把 App 拖进旁边的「应用程序」。App 未公证，首次打开被 Gatekeeper 拦时：

```bash
xattr -dr com.apple.quarantine /Applications/UsageAccumulator.app
```

<details>
<summary>从源码构建</summary>

```bash
pnpm install                     # 本机构建的 App 直接用仓库源码跑探针
cd apps/menubar-mac && ./build.sh
cp -R build/UsageAccumulator.app /Applications/
```
</details>

在面板的设置里填：

| 字段 | 填什么 |
|---|---|
| 服务器 | `https://ua.example.com` |
| Token | `UA_DASHBOARD_TOKEN` |
| Profile | 要显示的 profile，缺省 `claude-official` |
| 轮询（秒） | 30–600，默认 45 |

菜单栏默认会**托管本机探针**（随 App 启停，退出 App 即停止采集，下次打开靠游标补传）。
Release 版会在 Homebrew、`/usr/local/bin`、nvm、volta 等常见位置找全局安装的 `ua-probe`；
菜单里显示「探针：未配置」说明没找到，可以用 `~/Library/Application Support/UsageAccumulator/probe-launch.json` 指定启动命令。
探针要先按上面第 1 步 `install --no-service` 完成配对（由菜单栏托管时**不要**再装 launchd 服务）。

这台 Mac 已经用 launchd 跑探针时，把 `~/Library/Application Support/UsageAccumulator/mac.json` 里的
`superviseProbe` 改为 `false`，否则两个探针会抢同一个状态库。

本机开着系统代理时，如果连不上自建域名，给这个域名加直连规则。

### 4. 安卓 App 与桌面小部件

App 是一个 WebView 外壳，直接加载服务端托管的看板，网页更新后 App 自动是新版。
从 [Releases](https://github.com/Zack-Will/UsageAccumulator/releases) 下载 `UsageAccumulator-<版本>-android.apk` 安装（Android 12+）。

<details>
<summary>从源码构建</summary>

```bash
cd apps/android
cat > local.properties <<EOF
sdk.dir=$HOME/Library/Android/sdk
UA_DEFAULT_SERVER=https://ua.example.com     # 可选：首次启动预填
EOF
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

`local.properties` 里没配 `UA_KEYSTORE_FILE` 等正式签名时用 debug 密钥签名，这样的包和 Release 包不能互相覆盖安装，切换前要先卸载。
</details>

1. 首次打开填**服务器地址**（只支持 https），然后在页面里用看板密码登录。
2. 小部件默认沿用 App 里的登录状态；服务端没开密码登录时，在「设置 → 访问 token」里填 `UA_DASHBOARD_TOKEN`。
3. 添加小部件：「设置 → 添加卡片小部件 / 添加列表小部件」。小米 HyperOS 的系统小部件选择器只显示已上架应用，
   只能从 App 内添加。

构建细节、小部件样式与字体子集见 [`apps/android/README.md`](apps/android/README.md)。

---

## 开发

```bash
# 看板连真实服务端开发：/v1 由 Vite 代理并注入 token，token 不进浏览器
UA_DEV_API_BASE=https://ua.example.com UA_DEV_TOKEN=<UA_DASHBOARD_TOKEN> pnpm -F @ua/web dev

pnpm -F @ua/server dev           # 服务端热重载（需要 DATABASE_URL）
pnpm -F @ua/probe dev            # 前台跑探针
pnpm conformance                 # 契约一致性检查
```

`packages/ua-server/test/migrate-live.test.ts` 默认跳过，设置 `UA_TEST_DATABASE_URL` 后对真实 Postgres 跑迁移测试。

改了定价只需编辑 `deploy/pricing.json` 并重启服务端；改了表结构就在 `deploy/migrations/` 新增一个幂等的迁移文件（一律 `IF NOT EXISTS`）。

## 发布

推一个 `v*` tag，GitHub Actions（`.github/workflows/release.yml`）跑完测试后同时发布：
服务端镜像到 GHCR（amd64 + arm64），探针 tgz、Mac dmg 与安卓 APK 到 GitHub Release。
配了 `NPM_TOKEN` 时，探针还会同时发到 npm（`@zack-will/ua-probe`）。

```bash
git tag v0.2.0 && git push origin v0.2.0
```

带 `-` 的 tag（如 `v0.2.0-rc.1`）是预发布：npm 走 `next` 标签，镜像不更新 `latest`。
需要的仓库 Secrets：安卓签名用的 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`。
`NPM_TOKEN` 可选。正式 keystore 不在仓库里，丢了就再也发不出能覆盖安装的更新，务必另外备份。

## 延伸阅读

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：设计取舍、指标定义（预计用量、耗尽 ETA、标定、窗口重叠度）、安全与隐私
- [`docs/CONTRACT.md`](docs/CONTRACT.md)：HTTP API、数据类型、去重规则、额度会话接口
- [`apps/menubar-mac/README.md`](apps/menubar-mac/README.md)、[`apps/android/README.md`](apps/android/README.md)：各端实现细节
