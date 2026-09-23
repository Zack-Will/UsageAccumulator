# UsageAccumulator 架构设计

跨机器聚合 Claude Code 会话用量，结合官方限额窗口做预测与可视化。

**已确认的选型**：多账号（单人）· 本地机器代抓官方额度 · **全 TypeScript**（本机无 Rust 工具链，2026-09-21 改定）· VPS + Docker Compose + Postgres

---

## 1. 目标与非目标

### 目标
- 把散布在 Mac 与多台 Linux 机器上的 Claude Code 会话用量，汇总到一个云端服务
- 结合官方 5h / 7d 窗口的真实剩余额度，给出**预计用量**、**耗尽时间**、**用量分布**、**窗口重叠度**
- 支持多个 profile 并存：官方 OAuth 订阅账号 + 自定义 base_url 的 API key 网关
- 一个直观且美观的 Web 看板

### 非目标
- 不上报 prompt / 响应正文，只上报用量元数据
- 不做多租户权限体系（单人自用，预留 `owner_id` 字段但不实现 RBAC）
- 暂不支持 Windows 探针

---

## 2. 实测发现（基于本机 `~/.claude` 的真实数据）

这几条直接决定了设计，不是假设：

| 发现 | 证据 | 设计影响 |
|---|---|---|
| 用量记录在 `~/.claude/projects/<slug>/<session_id>.jsonl` 的 `type:"assistant"` 行 | 111 个文件 / 596MB | 首次接入需要 **backfill 模式**，不能只 tail |
| `message.usage` 含 `input_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` / `output_tokens` / `output_tokens_details.thinking_tokens`，以及 `cache_creation.ephemeral_1h_input_tokens` 与 `ephemeral_5m_input_tokens` 拆分 | 见样本 | 1h 与 5m 缓存**单价不同**，必须分开计费，不能只用 `cache_creation_input_tokens` 总数 |
| 每行带 `requestId`，`message.id` 为 `msg_xxx` | 同上 | 全局幂等键 = `(message_id, request_id)` |
| 存在 `ssh-<uuid>` 项目目录（24 个会话文件） | `~/.claude/projects/ssh-*` | **同一次请求会在本地和远端两台机器各留一份记录**，跨机去重是硬需求 |
| 部分行带 `ownerAccountUuid` / `ownerOrganizationUuid`，但 assistant 行上常为空 | 抽样 3 个最近会话均为 `None` | **不能只靠 JSONL 判定账号归属**，需要探针侧维护 profile 时间线 |
| 有 `apiBlockIndex` 字段（值 0） | 最近会话 | Claude Code 自己标记的 5h 块序号，可作为窗口切分的**交叉校验**信号，但跨机不可靠 |
| 本地**没有**任何限额缓存（`~/.claude/cache/` 只有 changelog 和 model-catalog；全目录 grep 无 `resets_at`/`utilization`） | grep 无命中 | 官方额度**必须**从云端接口代抓，省不掉这个组件 |
| `entrypoint` 区分 `claude-desktop` / `cli` | 22254 vs 6 | 可作为分布维度之一 |

### 2.0 实跑解析器的实测结果（2026-09-21，`packages/ua-core/scripts/validate-real.ts`）

对本机 111 个文件 / 558MB / 82,479 行全量解析：

| 指标 | 实测 | 结论 |
|---|---|---|
| 用量事件 | 28,794 条 → **去重后 10,423 条** | **64% 是重复**。同一条 assistant 消息按内容块多次落盘，`(message_id, request_id)` 去重是必需项 |
| 跨项目目录重复 | 441 条（占去重后 4.2%） | ssh 双写确实存在但占比低。**待确认项 #5 结案：v1 不做 `event_sightings` 表** |
| 缓存写入 1h 占比 | **87.8%**（288M / 328M） | 若按 cc-switch 的单列口径计价，近九成缓存写入会系统性算错。拆 5m/1h 的决定得到验证 |
| `missing-request-id` 告警 | 519 条 | `semantic_id` 兜底去重必须实现，不是可选项 |
| 模型实际取值 | `claude-opus-5`(19617) / `claude-fable-5-1`(5534) / `claude-fable-5`(2725) / `claude-opus-4-8` / `claude-opus-4-6` / `<synthetic>`(43) | 定价表要覆盖历史模型；**`<synthetic>` 是合成标记，必须排除计费与限额统计** |
| `entrypoint` 实际取值 | `claude-desktop`(28305) / **`claude-desktop-3p`(371)** / `cli`(118) | `-3p` 后缀很可能标记第三方/套壳入口，**这是 §14 套壳归属问题的一个现成信号**，v2 优先验证 |

### 2.1 cc-switch 现状（读本机 `~/.cc-switch/cc-switch.db` 得到）

cc-switch 已经做了一部分本项目要做的事，但**恰好缺的就是最关键的那块**：

| 发现 | 证据 | 设计影响 |
|---|---|---|
| 已有 `proxy_request_logs` 表，12595 条，含 tokens / cost / session_id / provider_id | 本机实查 | 结构可直接借鉴，字段几乎一一对应 |
| **但 `data_source` 只有 `session_log`(9693) 和 `codex_session`(2907)，没有一条 `proxy`** | `group by data_source` | 说明用量全部来自扫 JSONL，不是代理捕获 |
| **`provider_id` 全是 `_session` / `_codex_session` 占位符** | `group by provider_id` | ★ cc-switch 自己也**无法**把 session log 的用量归属到具体 provider，它直接放弃了 |
| `proxy_config` 中 4 个 app_type 的 `proxy_enabled` 全为 `0` | 实查 | 代理未启用，这正是上面两条的原因 |
| `cache_creation_tokens` 是**单列**，未拆 5m / 1h | schema | cc-switch 的成本计算在这一项上系统性偏差，本项目不能照抄 |
| `session_log_sync` 有 `last_byte_offset` + `last_tail_fingerprint`；`session-scan-cache.db` 有 `session_sync_resume`(byte_offset / tail_hash / file_identity) | schema | 断点续传设计与本文第 5.1 节不谋而合，可直接借鉴其字段 |
| `session_usage_dedup` 用 `(data_source, request_id)` + `semantic_id` 双重去重 | schema | `semantic_id` 是应对 `request_id` 缺失的兜底，值得借鉴 |
| providers 覆盖 `claude` / `codex` / `gemini` / `openclaw` / `grokbuild` 五种 app_type，含 `claude-official`(category=`official`) 与十余个第三方网关 | 实查 | 数据模型应携带 `app_type`，为日后扩展到 Codex 留位 |
| `session-scan-cache` 表为空（0 行），且未见 `ssh-*` 路径 | 实查 | cc-switch 未覆盖 ssh 远程会话，跨机去重仍需本项目自己做 |

### 2.2 官方额度接口（Claude-Usage-Tracker 实现确认）

它**本身就是一个 macOS 菜单栏原生 App**，不是浏览器扩展 —— 这意味着它的采集逻辑可以直接移植进我们的探针，形态天然吻合。

```
GET https://claude.ai/api/organizations/{org_id}/usage
    Cookie: sessionKey=<...>
→ { five_hour:      { utilization_pct, reset_at },
    seven_day:      { utilization_pct, reset_at },
    seven_day_opus: { utilization_pct, reset_at },
    extra_usage:    { ...当前额外消费与预算... } }

GET https://api.anthropic.com/v1/organization/{org_id}/usage
    x-api-key: <...>          ← 官方 API 账号用，第三方网关不适用
```

**确认：只有百分比，没有绝对 token 数。** 这对指标设计有连锁影响，见第 7.0 节。

> **字段名待核实**：上面的 `seven_day_opus` 是 Claude-Usage-Tracker 仓库里的写法。但实际受独立周限额约束的是 **Fable**，不是 Opus —— 说明该字段名要么已经改过，要么是这个第三方实现沿用了旧命名。抓包时**重点确认这个字段的真实名称**，不要照抄。设计上按 `window_kind` 字符串存，不硬编码枚举，改名不影响表结构。

---

## 3. 整体架构

```
┌──────────────── 机器 A：MacBook（primary probe）────────────────┐
│  ua-probe                                                      │
│   ├─ Watcher      inotify/FSEvents 监听 ~/.claude/projects      │
│   ├─ Parser       增量解析 JSONL → UsageEvent                   │
│   ├─ Attributor   按 profile 时间线打标（OAuth 账号 / API key）   │
│   ├─ Spool        本地 SQLite 缓冲，断网堆积、重启不丢            │
│   ├─ Shipper      批量 gzip NDJSON 上报                         │
│   └─ QuotaFetcher ★ 仅此机启用：用本机 session 拉官方剩余额度      │
└────────────────────────────────────────────────────────────────┘
┌──────────────── 机器 B..N：Linux 服务器 ────────────────────────┐
│  ua-probe（同一二进制，QuotaFetcher 关闭）                       │
└────────────────────────────────────────────────────────────────┘
                              │ HTTPS + Bearer(machine token)
                              ▼
┌──────────────── VPS：Docker Compose ───────────────────────────┐
│  ua-server (axum)                                              │
│   ├─ /v1/ingest/events    幂等 upsert，全局去重                  │
│   ├─ /v1/ingest/quota     官方额度快照                           │
│   ├─ /v1/query/*          看板查询                              │
│   ├─ Aggregator           窗口切分 / 预测 / 分布 / 重叠度          │
│   └─ Static               托管前端构建产物                       │
│  postgres:17                                                   │
│  caddy  （自动 HTTPS，反代 ua-server）                           │
└────────────────────────────────────────────────────────────────┘
                              │
                     Web 看板（React + Vite + ECharts）
```

### 技术栈变更说明（2026-09-21）
原定 Rust 探针 + Rust 服务端，但开工时发现**本机没有 Rust 工具链**（cargo / rustc 均未安装），而 Node 25 / pnpm / Docker / sqlite3 都在。在无编译器的情况下并行产出大量 Rust 代码无法验证，风险不可接受，因此改为**全 TypeScript 单仓**：

| | 原定 | 现定 | 得失 |
|---|---|---|---|
| 探针 | Rust 静态二进制 | Node + tsx | ✘ 每台 Linux 需 Node 运行时（或用 `bun build --compile` 打单文件）<br>✔ 可直接复用 ccusage 的解析逻辑 |
| 服务端 | axum | Fastify | 持平；Docker 部署差异不大 |
| 看板 | React + ECharts | 不变 | — |
| 菜单栏 | Tauri | Electron + Tray | ✘ 体积大（仅 Mac 一台，可接受）<br>✔ 与看板共用设计令牌 |

**探针的部署形态仍是目标**：v1 用 Node 跑，后续用 `bun build --compile` 产出单文件二进制，届时 Linux 侧无需 Node 运行时。这条路留在 M5。

---

## 4. 核心数据模型

### 4.1 Profile（解决"多账号 + 混合形态"）

这是本设计最关键的抽象。`OAuth 订阅账号` 和 `自定义 base_url + API key` 在**计量语义上根本不同**：

| | OAuth 订阅 | API key 网关 |
|---|---|---|
| 约束 | 5h / 7d 滚动窗口配额 | 账户余额 / 无窗口 |
| 核心指标 | 窗口利用率、耗尽 ETA | 累计花费、日均成本 |
| 额度来源 | 官方接口代抓 | 网关自己的接口（如有）或本地按单价累加 |

所以 `profile` 是一等公民，看板按 profile 切换视图，而不是把两者的数字混在一起求和。

```sql
CREATE TABLE profiles (
  id            TEXT PRIMARY KEY,          -- 'oauth-personal' / 'gw-openrouter'
  kind          TEXT NOT NULL,             -- 'oauth' | 'api_key'
  label         TEXT NOT NULL,
  account_uuid  TEXT,                      -- OAuth：对应 ownerAccountUuid
  base_url      TEXT,                      -- API key：自定义网关地址
  plan          TEXT,                      -- 'max_20x' 等，决定限额基准
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.2 归属判定（Attributor）★ 核心难点

**这是全项目技术风险最高的一环**，而 cc-switch 的现状恰好证明了它的难度：它扫了 9693 条 Claude 用量，`provider_id` 全部写成 `_session` 占位符 —— 也就是说它**放弃了归属判定**。我们不能简单"复用 cc-switch 的归属"，因为那个东西不存在。

设计成三级降级链，精度从高到低：

```
L1  cc-switch 代理日志（精确，但需开启代理）
     开启 proxy_config.proxy_enabled → Claude Code 流量经 127.0.0.1:15721
     每条请求在 proxy_request_logs 留下 (request_id, provider_id, session_id)
     探针读该表 → 用 request_id 与 JSONL 事件 JOIN → 得到确定的 provider_id
       ✔ 精确到每一次请求，切换 provider 的瞬间也不会错
       ✘ 仅 Mac（cc-switch 是桌面 App）；需用户主动开启代理

L2  provider 切换时间线（启发式，跨平台）
     监听 ~/.cc-switch/cc-switch.db 的 providers.is_current 变更（WAL 轮询）
       + ~/.claude/settings.json 的 env.ANTHROPIC_BASE_URL 变更
     → 记录 (changed_at, provider_id)，按 event.timestamp 二分查找
       ✔ 无需代理，Linux 也能用
       ✘ 切换瞬间的在途请求会归错；探针安装前的历史无时间线

L3  ownerAccountUuid / 探针默认 profile（兜底）
     JSONL 行上若有 ownerAccountUuid 则可确认是官方 OAuth 账号
     否则落到探针配置里的 default_profile_id
```

每条 `usage_event` 带一个 `attribution_level` 字段（`proxy` / `timeline` / `fallback` / `unknown`），看板上**明确标注归属可信度** —— 把不确定性显示出来，而不是假装数据是准的。这比悄悄给一个可能错的 provider 名字诚实得多。

> **建议**：在 Mac 上开启 cc-switch 的代理。这一个开关就把 Mac 侧的归属从"启发式猜测"变成"逐请求精确"，代价只是流量多走一跳本地回环。Linux 侧接受 L2 精度。

**历史数据**：探针安装前的 JSONL（你现在有 596MB）没有时间线可依，统一标 `attribution_level='unknown'`。它们只参与长期趋势，不参与当前窗口计算。

### 4.3 UsageEvent（上报单元）

```rust
struct UsageEvent {
    // 幂等键
    message_id: String,          // msg_xxx
    request_id: String,          // req_xxx
    // 归属
    machine_id: String,          // 探针安装时生成的 UUID，非主机名
    app_type: String,            // 'claude'（预留 codex/gemini，本期只用 claude）
    profile_id: String,
    attribution_level: AttrLevel,// Proxy | Timeline | Fallback | Unknown ← 归属可信度
    // 时间
    timestamp: DateTime<Utc>,
    // 用量
    model: String,
    input_tokens: i64,
    output_tokens: i64,
    thinking_tokens: i64,
    cache_read_tokens: i64,
    cache_write_5m_tokens: i64,  // ← 必须拆开，单价不同
    cache_write_1h_tokens: i64,
    // 维度
    session_id: String,
    project_slug: String,        // 可选 hash 化
    git_branch: Option<String>,
    entrypoint: String,          // claude-desktop | cli
    service_tier: String,
    is_sidechain: bool,          // subagent 产生的用量
    // 注：JSONL 里还有 effort / permissionMode 等字段，v1 不采集；
    //     需要时再加，加之前先改 CONTRACT §1.1
}
```

### 4.4 QuotaSnapshot（官方额度快照）

```sql
CREATE TABLE quota_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  profile_id    TEXT NOT NULL REFERENCES profiles(id),
  machine_id    TEXT NOT NULL,       -- 采集机器，便于追溯来源
  captured_at   TIMESTAMPTZ NOT NULL,
  window_kind   TEXT NOT NULL,       -- 'five_hour' | 'seven_day' | 顶配模型周窗口（真实字段名待抓包确认，见 2.2）
  utilization_pct DOUBLE PRECISION CHECK (utilization_pct BETWEEN 0 AND 100),  -- ★ 0..100，与 CONTRACT §4 一致，不要写成 0..1
  resets_at     TIMESTAMPTZ,         -- ★ 官方真实窗口结束时间
  raw           JSONB NOT NULL,      -- 原始响应，字段变动时可回溯重算
  UNIQUE (profile_id, window_kind, captured_at)
);
```

`raw JSONB` 是刻意保留的 —— 官方接口的返回结构不稳定，存原文才能在字段改名后重算历史。

### 4.5 事件表

```sql
CREATE TABLE usage_events (
  message_id            TEXT NOT NULL,
  request_id            TEXT NOT NULL,
  machine_id            TEXT NOT NULL,
  app_type              TEXT NOT NULL DEFAULT 'claude',
  profile_id            TEXT NOT NULL,
  attribution_level     TEXT NOT NULL DEFAULT 'unknown',
  ts                    TIMESTAMPTZ NOT NULL,
  model                 TEXT NOT NULL,
  input_tokens          BIGINT NOT NULL DEFAULT 0,
  output_tokens         BIGINT NOT NULL DEFAULT 0,
  thinking_tokens       BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens     BIGINT NOT NULL DEFAULT 0,
  cache_write_5m_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_1h_tokens BIGINT NOT NULL DEFAULT 0,
  session_id            TEXT NOT NULL,
  project_slug          TEXT,
  git_branch            TEXT,
  entrypoint            TEXT,
  service_tier          TEXT,
  is_sidechain          BOOLEAN NOT NULL DEFAULT false,
  cost_usd              NUMERIC(12,6),      -- 入库时按 model_pricing 算好
  PRIMARY KEY (message_id, request_id)      -- ★ 全局去重
);
CREATE INDEX ON usage_events (profile_id, ts DESC);
CREATE INDEX ON usage_events (ts DESC);
```

**主键即去重**：ssh 场景下 Mac 和远端机器会各上报一份同样的 `(message_id, request_id)`，`ON CONFLICT DO NOTHING` 直接吃掉。

代价：先到的那台机器会"赢得"这条记录的 `machine_id`，导致机器维度的归因有偏差。解决办法是额外建一张 `event_sightings(message_id, request_id, machine_id)` 记录"谁看见过这条"，机器分布图用它、总量用 `usage_events`。**建议 v1 先不做**，先观察 ssh 会话在你实际用量里的占比再决定。

---

## 5. 探针设计（ua-probe）

### 5.1 增量读取与断点续传

```
scan: 遍历 ~/.claude/projects/**/*.jsonl
  对每个文件维护 cursor { path, inode, size, offset, mtime }
  ├─ inode 变了        → 文件被重建，从 0 重读
  ├─ size < offset     → 被截断，从 0 重读
  └─ size > offset     → 从 offset 读到 EOF，逐行解析
cursor 存本地 SQLite，fsync 在成功上报之后
```

用 `notify` crate 监听目录事件触发扫描，同时保留 60s 的兜底轮询 —— FSEvents 在网络盘和某些容器挂载下会静默失效。

**首次 backfill**：596MB 全量解析一次。用 `rayon` 并行按文件切分，限速上报（每批 1000 条，间隔 200ms），避免首次接入把服务端打满。标记 `backfill=true`，服务端可选择跳过实时聚合。

### 5.2 缓冲与上报

本地 SQLite 队列（`WAL` 模式）：
- 解析出的事件先落队列，再异步发送
- 发送成功后删除；失败保留，指数退避重试（1s → 最长 5min）
- 队列超过 100 万条时丢弃最旧的（配合日志告警）

上报请求：`POST /v1/ingest/events`，body 为 gzip 的 NDJSON，header 带 `Idempotency-Key`（批次 hash）与 `Authorization: Bearer <machine_token>`。

### 5.3 额度采集：服务端直接抓（2026-09-23 起）

> **改动（2026-09-23）**：额度改由 **ua-server 自己抓**，探针代抓降为可选的旧路径（默认关）。
> 原因：代抓的那台机器是笔记本，一合盖、一出门，额度曲线就断档 —— 这段时间里手机聊天、
> 公司 Mac、NAS 上消耗的额度没人采样，燃尽、耗尽预估与「其他来源」归因一起失真。
> 服务端 7×24 在线，自己抓才干净；它也本来就是唯一需要这份数据的地方。
>
> - 会话：看板顶栏点「额度更新」→ 粘贴浏览器 Cookie 里的 `sessionKey`。服务端先拿它问 claude.ai，
>   认了才保存。**服务端替不了浏览器登录**（邮件 / Google 登录要过人机验证，不做）。
> - 存放：`UA_CLAUDE_SESSION_DIR`（默认 `~/.config/ua-server/claude-sessions/<profile_id>`，0700 / 0600），
>   **不进数据库**，免得跟着备份和 pg_dump 走。接口只写不读，GET 只给状态（CONTRACT §2.4）。
> - 节奏与判错沿用下面探针那一套（5 分钟 + 抖动；401/403 阶梯退避），代码共用 `@ua/core` 的 `ClaudeWebClient`。
>   额外区分了 Cloudflare 质询（HTML 挑战页）与会话失效：前者换会话没用，提示不能混。
> - 看板顶栏在会话失效 / 被拦截 / 未登录时直接显示这几个字（手机上也显示）。
>
> 以下是探针代抓的原设计，保留作旧路径说明。

移植 Claude-Usage-Tracker 的采集逻辑。它本身就是 macOS 原生菜单栏 App，形态与我们的 Mac 探针一致，移植成本低。

```
1. 取 org_id：GET https://claude.ai/api/organizations   （sessionKey cookie）
2. 拉额度：  GET https://claude.ai/api/organizations/{org_id}/usage
3. 解析：    five_hour / seven_day / seven_day_opus → utilization_pct + reset_at
             extra_usage → 额外消费与预算
4. 上报：    POST /v1/ingest/quota，附带完整 raw JSON
```

```toml
[quota]
enabled       = true
profile_id    = "claude-official"
interval_secs = 300          # 5 分钟一次，别更频繁
jitter_secs   = 60           # 随机抖动，避免固定节奏被识别
credential    = "keychain"   # macOS Keychain;Linux 用 0600 文件
```

- 凭证**只存本机**，绝不上报服务端。服务端只收到 `utilization_pct` / `reset_at` / `raw`
- 401 时指数退避 + 本机通知（`osascript` 弹窗）提示重新登录;**不重试到被风控**
- `raw` 原样入库：官方字段改名时可回溯重算，不丢历史
- 抽象成 `trait QuotaSource`，`ClaudeWebSource` / `AnthropicApiSource` 各一个实现;接口变了只换实现

> 第二个端点 `api.anthropic.com/v1/organization/{org_id}/usage`（`x-api-key` 鉴权）只适用于官方 API 账号。**你的第三方网关（Anyrouter / Zenmux / LiteLLM 等）不适用** —— 那些 profile 的成本只能靠本地按单价累加，或各网关自己的接口，逐个适配。

### 5.4 部署形态

单个静态链接二进制（`x86_64-unknown-linux-musl` / `aarch64-apple-darwin` / `aarch64-unknown-linux-musl`）：

```
ua-probe install --server https://ua.example.com --token <enroll-token>
  → 生成 machine_id，写 ~/.config/ua-probe/config.toml
  → macOS: 写 ~/Library/LaunchAgents/com.ua.probe.plist 并 launchctl load
  → Linux: 写 ~/.config/systemd/user/ua-probe.service 并 systemctl --user enable --now
```

Linux 上用 user service 而非 system service —— 因为要读 `$HOME/.claude`，且无需 root。记得提示 `loginctl enable-linger $USER`，否则 SSH 断开后 user service 会被杀。

---

## 6. 服务端设计（ua-server）

### 6.1 技术栈
`axum` + `sqlx`(Postgres) + `tokio`。单二进制，Dockerfile 用 `scratch`/`distroless` 多阶段构建。

### 6.2 聚合引擎

**窗口切分**（借鉴 ccusage 的 blocks 算法，再用官方数据校准）：

```
本地推算：
  1. 按 profile 取事件流，按 ts 排序
  2. 第一条事件的时间向下取整到小时 → block 起点
  3. block 时长 5h；若相邻事件间隔 > 5h，则下一条另起新 block
官方校准：
  取最近的 quota_snapshot.resets_at → 真实窗口终点
  真实窗口起点 = resets_at - 5h
  offset = 真实起点 - 推算起点    ← 这就是"窗口偏移量"
```

聚合结果写入物化视图 `usage_hourly`（按 profile × machine × model × hour 预聚合），看板查询走视图，原始表只用于回溯重算。Postgres 侧用 `REFRESH MATERIALIZED VIEW CONCURRENTLY`，每分钟一次。

---

## 7. 指标定义

这部分是整个项目的价值所在，定义要精确。

### 7.0 百分比 → token 的标定（Calibration）★

官方只给 `utilization_pct`，不给绝对值。天真的做法是整个看板都用百分比 —— 但那样会丢掉一个关键能力：**无法回答"我这个项目吃掉了多少额度"**，因为本地只有 token 数，官方只有百分比，两者对不上。

解法是把限额**反解出来**。我们同时拥有两组数据：

- 官方的 `utilization_pct(t)`，5 分钟一个采样点
- 本地的逐请求 token 数，精确到毫秒

在同一个窗口内取相邻两个采样点，就得到一组观测：

```
Δpct = pct(t₂) − pct(t₁)                       ← 官方
tokens_m = 窗口内 [t₁,t₂) 各模型 m 的消耗量      ← 本地
```

若限额是各模型 token 的加权和（Opus 权重高于 Sonnet，这与官方对 Opus 单独设 7d 限额的事实一致），则：

```
Δpct / 100 = ( Σ_m  w_m · tokens_m ) / L
```

`w_m`（模型权重）和 `L`（限额绝对值）都未知，但只要积累足够多的观测点，这就是一个**非负最小二乘问题**，可以解出 `w_m / L` 这组比值。再固定某个基准模型 `w_sonnet = 1`，即可得到 `L` 的估计值与各模型权重。

```ts
// 解 min ‖A·x − b‖²  s.t. x ≥ 0
//   A[i][m] = 第 i 个观测区间里模型 m 的 token 数
//   b[i]    = 第 i 个观测区间的 Δpct / 100
//   x[m]    = w_m / L
// 用 nnls crate 或自己写个投影梯度，规模极小（模型数 × 观测数）
```

**工程约束**（不做会解出垃圾）：
- 只用**单机独占**的观测区间。多机并发时本地 token 总量可能不全（某台探针掉线），会污染回归
- 剔除 `Δpct = 0` 的区间（窗口空闲）和跨窗口边界的区间（pct 会归零）
- 标定结果带**置信区间**，观测点不足 30 个时看板显示"标定中"，不显示换算后的绝对值
- 每个 `plan` 独立标定；官方调整限额时残差会突然变大 → 以此**自动触发重新标定**，并在看板提示"限额似乎发生变化"

**降级**：标定未完成时，所有指标以百分比呈现，功能不受影响，只是少了 token 维度的换算。标定完成后自动解锁"项目/机器消耗了多少额度"这类问题。

这个设计的附带好处是：**你能知道自己套餐的真实限额是多少**，而官方从来没直接告诉过你。

---

### 7.1 5h 预计用量

```
W          = 当前 5h 窗口 [start, start+5h)
used(t)    = 官方 utilization_pct（权威），本地 token 累加仅用于采样点之间的插值
rate       = 最近 30 分钟的消耗速率（token/min），用 EWMA 平滑，半衰期 10min
remaining  = start + 5h - now
projected  = used(now) + rate × remaining
```

看板同时给出三条预测线：**保守**（rate 取最近 30min 的 P25）、**当前**（EWMA）、**激进**（P75）。单点预测在这种波动剧烈的场景里没有意义 —— 一次 backfill 或者长 context 会话就能把线性外推打飞。

### 7.2 7d 预计用量

同上，但 `rate` 改用**按天的日历模式**而非线性速率：

```
projected_7d = used_so_far + Σ(未来每一天的预测量)
未来某天的预测量 = 历史同星期几的日均用量 × 近期趋势系数
```

理由：7 天窗口里周末和工作日的差异巨大，线性外推会系统性高估。

### 7.3 耗尽 ETA

```
eta = now + (100 - pct(now)) / rate_pct        ← 百分比口径，始终可用
rate_pct = 最近 30min 的 pct 增长速率（EWMA）
```
标定完成后额外给出 token 口径的 ETA。**百分比口径不依赖标定**，所以这个核心指标从第一天就可用。
当 `projected < limit` 时显示"本窗口不会耗尽"，而不是给一个窗口结束之后的假时间。

### 7.4 用量分布

四个维度，都是同一份 `usage_hourly` 的不同切法：
- **机器**：堆叠面积图，一眼看出哪台机器在吃额度
- **项目 / git 分支**：Treemap
- **模型**：Opus / Sonnet / Fable 的占比（Opus 通常有独立的 7d 限额）
- **时段**：星期 × 小时的热力图，找出自己的用量节律

外加一个容易被忽略但很重要的拆解：**cache_read 占比**。缓存命中率高说明会话组织得好，这个数字随时间的变化是可优化项。

### 7.5 窗口重叠度 ★

"重叠度"拆成四个可计算的指标：

| 指标 | 定义 | 回答什么问题 |
|---|---|---|
| **窗口偏移** | `官方 resets_at - 本地推算窗口终点`（分钟） | 我本地算的窗口准不准？误差多大？ |
| **多机重叠度** | 窗口内，有 ≥2 台机器同时产生用量的时间占窗口总时长的比例 | 我是不是在几台机器上并行烧同一个额度？ |
| **会话切断率** | 跨越窗口边界的会话数 / 总会话数 | 有多少次是干到一半被窗口切断的？ |
| **窗口浪费度** | `(limit - used_at_window_end) / limit` | 窗口白白过期了多少额度？ |

可视化用**窗口时间轴甘特图**：横轴是 5h 窗口，每台机器一条泳道，色块表示该机器在该时段的用量强度，窗口边界画红色竖线。多机重叠和会话切断在这张图上是**肉眼可见**的，不需要看数字。

---

## 8. 前端设计

### 布局

```
┌─────────────────────────────────────────────────────────┐
│ [Profile 切换器]                        [时间范围] [刷新] │
├──────────────────┬──────────────────┬───────────────────┤
│  5h 窗口环形进度  │  7d 窗口环形进度  │   耗尽 ETA 卡片    │
│  已用 62%        │  已用 41%        │   还剩 1h48m      │
│  预计 87%(±12)   │  预计 58%(±9)    │   当前速率 ▲      │
├──────────────────┴──────────────────┴───────────────────┤
│  燃尽曲线：已用实线 + 三条预测带 + 限额红线 + 窗口边界      │
├─────────────────────────────────────────────────────────┤
│  窗口时间轴甘特图（每台机器一条泳道）                      │
├───────────────────────────┬─────────────────────────────┤
│  机器分布（堆叠面积）       │  模型占比（环形）            │
├───────────────────────────┼─────────────────────────────┤
│  项目 Treemap             │  星期×小时 热力图            │
└───────────────────────────┴─────────────────────────────┘
```

### 美学基线
- **暗色优先**，但 light/dark 都要能看。颜色用 CSS 变量定义在 `:root`，两套主题各定义一次
- 图表配色用**同一套 5~7 色的分类色板**贯穿所有图，机器 A 在哪张图里都是同一个颜色 —— 这是让多图表看起来像一个系统的最关键一点
- 燃尽曲线的预测带用**半透明区间**而非三条实线，避免视觉噪音
- 数字排版用等宽数字字体（`font-variant-numeric: tabular-nums`），刷新时不跳动
- 实时性：SSE 推送（`/v1/stream`），而不是轮询。数字变化用 300ms 补间动画，不要直接跳变

### 技术选型
`React 19 + Vite + TypeScript + ECharts + TailwindCSS`。ECharts 的理由：甘特图、Treemap、热力图、带区间的折线图它全都原生支持，换 Recharts 有一半要自己画。

---

## 9. 安全与隐私

| 项 | 方案 |
|---|---|
| 探针认证 | 安装时用一次性 enroll token 换取长期 machine token；服务端可单独吊销某台机器 |
| 传输 | HTTPS only，Caddy 自动证书 |
| 官方凭证 | claude.ai 会话存**服务端**（`UA_CLAUDE_SESSION_DIR` 下 0600 文件，不进数据库），看板只写不读，任何接口不回显（§5.3，2026-09-23 起）。探针代抓的旧路径仍是只存本机 |
| 内容隐私 | 只上报 usage 数字与维度，不含任何 prompt / 响应 / 工具参数 |
| 项目路径 | 配置项 `hash_project_paths = true` 时上报 HMAC 后的 slug，看板显示别名 |
| 看板访问 | v1 用单一 Bearer token + Caddy basic auth 即可；不做用户体系 |

---

## 10. 从参考项目复用什么

| 项目 | 复用 | 不复用 / 需修正 |
|---|---|---|
| **ccusage** | JSONL 字段语义、`(message_id, request_id)` 去重、5h block 切分算法、模型定价表（LiteLLM 数据源） | 整个 TS 实现（核心解析用 Rust 重写，约 500 行） |
| **cc-switch** | ① `proxy_request_logs` 表结构（字段几乎一一对应）<br>② `session_sync_resume` 的断点续传字段（byte_offset / tail_hash / file_identity）<br>③ `session_usage_dedup` 的 `semantic_id` 兜底去重思路<br>④ `model_pricing` 表可直接读用<br>⑤ **开启其代理后，`proxy_request_logs` 是 L1 归属的数据源** | ✘ 它的 `provider_id` 归属（全是 `_session` 占位，等于没有）<br>✘ 它的 `cache_creation_tokens` 单列口径（未拆 5m/1h，计费偏差）<br>✘ 不改写它的任何配置，只读 |
| **Claude-Usage-Tracker** | 官方额度端点、org_id 获取流程、响应解析;它是原生菜单栏 App，采集逻辑可直接移植 | 其 UI 与菜单栏形态（留到 M5 再做） |

**与 cc-switch 的关系定位**：单向只读依赖。我们读它的 `cc-switch.db`（providers、model_pricing、proxy_request_logs），**绝不写入**。它是 provider 的"真相源"，我们是用量的"聚合层"，职责不重叠。

## 11. 仓库结构

```
UsageAccumulator/
├─ packages/
│  ├─ ua-core/       # 共享：JSONL 解析、UsageEvent、定价、窗口算法
│  ├─ ua-tokens/     # 共享：设计令牌（看板与菜单栏共用）
│  ├─ ua-server/     # Fastify + Postgres
│  └─ ua-probe/      # 探针
├─ apps/
│  ├─ web/           # React + Vite + ECharts 看板
│  └─ menubar/       # Electron 托盘（仅 macOS）
├─ deploy/
│  ├─ docker-compose.yml
│  ├─ Caddyfile
│  └─ migrations/
└─ docs/
   ├─ ARCHITECTURE.md
   └─ CONTRACT.md    # 并行开发的接口契约
```

`@ua/core` 同时被探针和服务端依赖 —— 定价表和窗口算法在两边必须完全一致，共享包是唯一能保证这点的方式。

---

## 12. 分阶段实施

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **M1 骨架** | `@ua/core` 解析器 + 单元测试（用真实 JSONL 做 fixture），含 5m/1h 缓存拆分 | 对本机 596MB 全量解析，token 总数与 `ccusage` 一致 |
| **M2 链路** | 探针 tail + 上报，服务端 ingest + Postgres，最简列表页 | 两台机器同时上报，ssh 重复会话被正确去重 |
| **M3 额度** | QuotaFetcher 打通（移植 Usage-Tracker），quota_snapshots 入库，窗口校准 | 本地推算窗口与官方 `reset_at` 偏移 < 5 分钟 |
| **M3.5 归属** | Attributor 三级链;读 cc-switch DB（L1 代理日志 / L2 切换时间线） | 开启代理后 Mac 侧 `attribution_level='proxy'` 占比 > 95% |
| **M4 标定** | 非负最小二乘反解限额与模型权重 | 累计 ≥30 个干净观测点后，标定残差 < 5%，看板解锁 token 口径 |
| **M5 看板** | 完整可视化，SSE 实时刷新 | 第 7 节全部指标可见，归属可信度可见 |
| **M6 打磨** | Tauri 菜单栏 App、额度将尽告警、多 profile 对比 | — |

M1 的验收标准是刻意设计的：**用 ccusage 的输出做 golden test**，解析正确性有了外部基准，后面所有统计才站得住。

注意 M4 依赖 M3 积累的采样点 —— 标定需要时间序列，不是写完代码就能出结果。5 分钟一个采样点，攒够 30 个干净观测至少要几天的正常使用。**所以 M3 要尽早上线开始攒数据**，不必等看板做完。

---

## 13. 待确认

0. **定价表已核实**（2026-09-21）：`deploy/pricing.json` 从 LiteLLM 程序化生成（28 个模型），并已与 Anthropic 官方定价页逐条比对——实测出现过的 7 个模型 × 5 个价格字段全部一致。其中 `claude-fable-5-1` 的缓存读单价是输入价的 **0.025x**（其余模型是 0.1x），**这是官方特例而非数据错误**，代码里不要"顺手改正"。

1. ~~官方额度接口~~ **已确认**：`claude.ai/api/organizations/{org_id}/usage` + sessionKey，返回百分比 + reset_at。仍建议写码前手工 curl 验证一次当前字段名。
2. ~~限额是百分比还是绝对值~~ **已确认为百分比**，已设计第 7.0 节的标定方案反解绝对值。
3. ~~是否在用 cc-switch~~ **已确认在用**，且已读到真实 schema。**新的待确认：你是否愿意开启 cc-switch 的代理**（`proxy_config.proxy_enabled`，本机现为 0）？开启则 Mac 侧 provider 归属从启发式变精确，这是归属精度的分水岭。
4. ~~Linux 机器访问方式~~ **已确认**：假定全部可直连服务端，探针不做代理/穿透支持，服务端如何暴露公网由部署层自行解决。
5. **ssh 会话跨机重复率：先前的估算错了，真实值高一个数量级。**

   - 先前（仅用 Mac 本地数据估算）：跨项目目录重复 441 条，占去重后事件 4.2%，据此判断"v1 不做 `event_sightings`"。
   - **真实双机试跑（2026-09-21，Mac + home-nas-vm）**：Mac 上报 10,959 条、home-nas-vm 上报 2,658 条，合计 13,617 条，入库仅 **10,964** 条 —— **2,653 条是两台机器记录的同一批请求**，占 Mac 上报量的 **24%**。

   为什么先前估低了：只有 Mac 的数据时，我只能看到"同一台机器上跨项目目录的重复"。而真正的大头是 **Mac 通过 ssh 连到远端跑的会话，两端各留了一份完整记录** —— 这要两台机器的数据同时在库里才看得见。

   **后果**：这 2,653 条归属给了**先入库的那台机器**（本次是 home-nas-vm，因为它先跑完 backfill）。语义上这其实是对的（活儿确实在那台机器上跑），但**结果依赖上报顺序** —— 如果 Mac 先跑完，同一批事件就会算到 Mac 头上。机器维度的分布图因此不是稳定的。

   **结论修正**：`event_sightings` 表（记录"哪些机器见过这条事件"）从"不必要"上调为 **v2 应该做**。总量统计不受影响（去重是对的），但机器维度的归因需要它才能稳定。
6. **是否纳入 Codex / Gemini**：你的 cc-switch 里有 `codex` / `gemini` / `openclaw` / `grokbuild` 四种其他 app_type，且已有 2907 条 Codex 用量。数据模型已预留 `app_type` 字段，**本期只做 Claude**，但不会因此产生迁移债。

---

## 13.5 首次双机试跑记录（2026-09-21）

服务端 home-nas-vm（Ubuntu 24.04）· 探针 Mac + home-nas-vm · 内网明文 HTTP。

**跑通了什么**：enroll → gzip NDJSON 上报 → 入库去重 → 看板端点全部 200。入库 10,964 条事件、$3,573 成本、0 条缺价。归属判定按设计工作（两台机器都以 live `settings.json` 为准判为 `claude-official`，而没有信 cc-switch 的 `is_current`）。

**部署层面的偏离**（这台机器的环境限制，非设计问题）：

| 偏离 | 原因 |
|---|---|
| 服务端用宿主机 Node 直接跑，未用 compose 构建镜像 | 该机 `docker compose` v5.1.0 构建与 `up` 均无输出地挂起；daemon 本身健康（31 个其他容器在跑） |
| Postgres 用 `18-alpine` 而非 `17` | 17 的镜像拉取在该机屡次失败；18-alpine 已缓存。迁移在 17 和 18 上均验证通过 |
| 探针用 `--no-service`，靠 `setsid nohup` 常驻 | 试跑阶段先不动 systemd；正式化时再装 user service（记得 `loginctl enable-linger`） |

**发现的真 bug**：见 §13.6。

## 13.7 当前部署状态（2026-09-21）

公网入口 **`https://ccusage.zackwill.space`**，链路与 `lab.zackwill.space` 同构：
`DNS → 杭州 47.96.31.46:443 nginx catch-all(*.zackwill.space) → 127.0.0.1:7770 frps → 家庭 frpc → NAS VM 127.0.0.1:8787`

| 组件 | 位置 | 托管方式 | 开机自启 |
|---|---|---|---|
| Postgres 18-alpine | home-nas-vm | docker `ua-postgres` | `restart=unless-stopped` |
| ua-server（含看板静态托管） | home-nas-vm | systemd user `ua-server.service` | ✓（linger 已开） |
| ua-probe | home-nas-vm | systemd user `ua-probe.service` | ✓ |
| ua-probe | Mac | launchd `com.zackwill.ua-probe` | ✓ |
| ua-menubar | Mac | launchd `com.zackwill.ua-menubar` | ✓ |

**额度采集**（2026-09-23 起）：由 ua-server 内置采样器直接抓，会话文件在 NAS VM `~/.config/ua-server/claude-sessions/`；两台探针的 `[quota] enabled` 均为 `false`。

四个服务均已实测「杀掉进程后自动拉起」。

**基建侧改动**（按 SOP 走，回滚点见下）：`00-core.toml` 新增 `ubuntu-ccusage-8787`，core 47→48，备份 `00-core.toml.pre-ccusage-20260921T025104Z`；杭州 `domains.yaml` 的 `ali` 组新增 `ccusage`，声明 49→50，备份 `domains.yaml.bak-ccusage-20260921T025216Z`。nginx 与证书未动（泛域名覆盖）。

**看板托管与 token**：服务端用 `@fastify/static` 在**同源**托管构建产物（`UA_WEB_DIR`）。同源是刻意的 —— 跨源时 `EventSource` 无法带自定义头，SSE 的 token 只能进 query string 并落进访问日志。
**产物中不含任何 token**：前端改为运行时从 localStorage 读取，首次打开由使用者在本机输入一次；`VITE_UA_TOKEN` 只保留作开发便利，生产构建绝不设置（Vite 会把它原样内联进公开 JS）。

**已知未完成**：额度采集（见 §13.8）；菜单栏未正式打包成 `.app`，其自带的开机自启开关因缺少 bundle 身份而失效（当前由 launchd 代劳）。

## 13.8 额度采集在本网络环境下走不通（2026-09-21 实测）

> **已推翻（2026-09-22）**：下表四次测试用的都是 curl，Cloudflare 拦的是 curl 的 TLS 指纹，不是网络位置。
> undici（Node）、URLSession、Chromium 在同一条链路上都能正常取到 usage。
> 2026-09-23 从 NAS VM 用 Node 发不带凭证的请求复核：过了 Cloudflare、未判地区不可用，只因未登录被拒（`account_session_invalid`）。
> 额度随后改由服务端直接抓（§5.3）。下面保留原记录，作为「用 curl 下结论」的反例。

§2.2 假设「本地机器代抓，住宅 IP + 真实 UA，风控友好」。**实测该假设不成立**：

| 出口 | 结果 |
|---|---|
| 家宽（探针直连） | Cloudflare `Just a moment...` 403 |
| 家宽经本机代理 | 同样 403 |
| RackNerd 美国 / Azure 日本 | Cloudflare 挑战页 |
| 杭州 | 过了 Cloudflare，但 `region_unavailable` |

关键证据：**不带任何凭证的裸请求也是 403**，所以卡点在网络位置而非认证。能过 Cloudflare 的节点在区域黑名单里，不在黑名单的过不了 Cloudflare。

未尝试破解该挑战（属 bot 检测，不做）。探针的 `quota.enabled` 已置 false，避免每 15 分钟反复撞 Cloudflare。

**候选方向**：① 浏览器扩展或本地拉起浏览器登录取 `cf_clearance` + `sessionKey`（需确认家宽是否同时受区域限制）；② 找一个既不被质询又不受区域限制的出口（DMIT 洛杉矶、甲骨文新加坡尚未测，其别名只在 NAS VM）；③ 放弃官方窗口只做本地 token 统计 —— 但 §7.0 的标定、燃尽曲线与耗尽 ETA 会一并失效。

## 13.6 只有连真库才会暴露的 bug

`runMigrations()` 用 `sql.unsafe(content)` 在**连接池**上执行迁移文件，而迁移文件自带 `BEGIN;`/`COMMIT;`，postgres.js 直接以 `UNSAFE_TRANSACTION` 拒绝（连接可能在事务中途被归还给其他请求），服务端启动即 fatal。

**为什么之前没发现**：服务端的 121 个测试用的是 `MemoryStore`，迁移测试只做 SQL 文本的静态检查 —— 两条防线都碰不到真实驱动。

**修法**：改用 `sql.reserve()` 取独占连接执行，保留迁移文件自带的事务控制。推论是**迁移文件必须幂等**（一律 `IF NOT EXISTS`），因为记账的 INSERT 在文件自身 COMMIT 之后，进程若在两者之间崩溃会重跑该文件。

**补的防线**：`packages/ua-server/test/migrate-live.test.ts`，默认跳过，设了 `UA_TEST_DATABASE_URL` 才跑；除了迁移本身，还断言主键、5m/1h 分列、`cost_usd` 非浮点、无正文列、无 `timestamp without time zone`。

## 14. 已知的 v2 问题：套壳客户端与同机多账号

**决策：v1 只做官方订阅（`claude-official`），不处理以下情况，但数据模型不能被它堵死。**

公司 Mac 上有自研套壳 `codewiz-cc`，内核是 Claude Code，工作中用个人 Fable 指派公司 Opus 干活。这会同时破坏两个维度的归因：

| 破坏点 | 原因 | v2 需要的能力 |
|---|---|---|
| **profile 维度** | 同一台机器上，个人订阅与公司账号的用量混在一起 | 归属不能以 machine 为粒度，必须能在单机内按会话/请求切分 |
| **机器维度** | 套壳可能改写 `CLAUDE_CONFIG_DIR`，或把会话写到非标准路径 | 探针的目录发现不能硬编码 `~/.claude/projects` |
| **窗口计算** | 公司账号有独立的 5h/7d 窗口，与个人账号完全无关 | 窗口必须按 profile 独立计算，绝不能跨 profile 求和 |
| **模型口径** | 套壳可能改写模型名（如已观察到的 `claude-opus-5[1m]`） | 定价与权重表需要模型名归一化层 |

**v1 要预留的**（成本几乎为零，但能避免 v2 大改）：

1. 探针的扫描路径**可配置**，支持多个根目录：`scan_roots = ["~/.claude/projects", ...]`，而非硬编码
2. `usage_event` 已带 `profile_id` 与 `attribution_level`，**天然支持单机多 profile**，无需迁移
3. 窗口聚合按 `profile_id` 分组（第 6.2 节已如此设计），不会出现跨账号求和
4. 模型名入库前过一层 `normalize_model()`，v1 实现为恒等函数，v2 再填规则

**不预留的**：套壳的探测与识别逻辑，等 v2 拿到 codewiz-cc 的实际行为（配置目录、模型命名、是否有 OAuth）再做。

> 补充一个第 4.2 节的重要修正（本机实测发现）：cc-switch 的 `providers.is_current` **可能与 live 配置不同步** —— 本机 `is_current=1` 指向 Anyrouter，但 `~/.claude/settings.json` 根本没有 `env` 段，实际跑的是官方 OAuth。**L2 时间线必须以 live `settings.json` 为准**，信 `is_current` 会把官方账号的用量整片记错。
