# 接口契约

**这份文档是并行开发的唯一真相源。** 任何跨组件的类型、字段名、端点、状态码，以此为准；实现与本文不一致时改实现，不改本文（确需改本文时先在此处改，并同步通知其他组件）。

全栈 TypeScript（pnpm workspace）。线上格式以本文为准。

---

## 0. 组件边界与目录归属

| 组件 | 目录 | 职责 | 不得改动 |
|---|---|---|---|
| **ua-core** | `packages/ua-core/` | 共享：JSONL 解析、UsageEvent、定价、窗口算法 | 由主会话维护，其他组件只读 |
| **ua-server** | `packages/ua-server/` `deploy/` | ingest / query API、聚合、迁移 | 探针与前端目录 |
| **ua-probe** | `packages/ua-probe/` | 文件监听、断点续传、缓冲上报、额度采集、cc-switch 读取 | 服务端与前端目录 |
| **ua-menubar** | `apps/menubar/` | macOS 托盘常驻，只显示基础信息 | 其他目录 |
| **ua-web** | `apps/web/` | 看板前端 | 其他目录 |
| **ua-tokens** | `packages/ua-tokens/` | 设计令牌，看板与菜单栏共用 | 由主会话维护，只读 |

跨目录需要改动时：**不要直接改，报告给主会话**。

---

## 1. 核心数据类型

### 1.1 UsageEvent（探针 → 服务端）

```jsonc
{
  "message_id": "msg_011Ced1B5UT6t1Tyq1TcTP2g",  // 必填且**恒非空**
  "request_id": "req_011Ced1B2YLFyeZdtzq12Z8Y",  // 可为空字符串（实测 519 条缺失）
  "semantic_id": "9f2c1a7e4b...",                // 必填，恒定存在；request_id 缺失时作为去重身份
  "machine_id": "9f2c1a7e-...",                  // 探针安装时生成的 UUID，非主机名
  "app_type": "claude",                          // claude | codex | gemini（v1 只用 claude）
  "profile_id": "claude-official",
  "attribution_level": "timeline",               // proxy | timeline | fallback | unknown
  "ts": "2026-09-01T16:04:45.751Z",              // RFC3339，UTC
  "model": "claude-opus-5",
  "input_tokens": 2,
  "output_tokens": 726,
  "thinking_tokens": 295,
  "cache_read_tokens": 38256,
  "cache_write_5m_tokens": 0,                    // ★ 必须与 1h 分开
  "cache_write_1h_tokens": 31626,
  "session_id": "a5836485-6e66-4df1-9fe9-d1f7b7f1c7e2",
  "project_slug": "-Users-zhouweichuan-Repos-Cleave",  // 可选 HMAC 化
  "git_branch": "HEAD",
  "entrypoint": "claude-desktop",                // claude-desktop | cli
  "service_tier": "standard",
  "is_sidechain": false,
  "backfill": false                              // 首次全量导入时为 true
}
```

**字段来源（JSONL 行）**：只取 `type == "assistant"` 且 `message.usage` 存在的行。

| 契约字段 | JSONL 路径 |
|---|---|
| `message_id` | `message.id` |
| `request_id` | `requestId` |
| `ts` | `timestamp` |
| `model` | `message.model` |
| `input_tokens` | `message.usage.input_tokens` |
| `output_tokens` | `message.usage.output_tokens` |
| `thinking_tokens` | `message.usage.output_tokens_details.thinking_tokens` |
| `cache_read_tokens` | `message.usage.cache_read_input_tokens` |
| `cache_write_5m_tokens` | `message.usage.cache_creation.ephemeral_5m_input_tokens` |
| `cache_write_1h_tokens` | `message.usage.cache_creation.ephemeral_1h_input_tokens` |
| `session_id` | `sessionId` |
| `project_slug` | 所在目录名 |
| `git_branch` | `gitBranch` |
| `entrypoint` | `entrypoint` |
| `service_tier` | `message.usage.service_tier` |
| `is_sidechain` | `isSidechain` |

> `cache_creation_input_tokens` 是 5m + 1h 的**总和**，仅作校验用，不入库。若 `cache_creation` 对象缺失，退化为全部计入 `cache_write_5m_tokens` 并记一条 warn。

### 1.2 去重

主键 `(message_id, request_id)`。任一缺失时用 `semantic_id` 兜底：

```
semantic_id = sha256(session_id | ts_ms | model | input | output | cache_read | cache_write_5m | cache_write_1h)[:32]
```

**`message_id` 恒非空。** 实测 29,198 条真实事件中 `message_id` 为空 **0 条**、两者同时为空 **0 条**，因此主键 `(message_id, request_id)` 不会全局撞车。探针解析出空 `message_id` 时**丢弃该事件并告警**，不得上报；服务端收到空 `message_id` 一律 `400`。

**线格式规定**：`semantic_id` **永远填写**，不因 `request_id` 存在而省略。`request_id` 缺失时填空字符串 `""`，不要填 null、不要拿 semantic_id 冒充 request_id。服务端据此选择主键路径。

服务端 `ON CONFLICT DO NOTHING`。**同一次请求会被多台机器上报**（ssh 场景），这是预期行为。

实测口径（见 ARCHITECTURE §2.0）：28,794 条原始事件去重后剩 10,423 条，**64% 是重复**；其中跨机重复仅 441 条。探针会先在本地去重一轮（实测吃掉 56%），服务端仍须自己再去一次，不得假设上游已去干净。

### 1.3 QuotaSnapshot（探针 → 服务端）

```jsonc
{
  "profile_id": "claude-official",
  "machine_id": "9f2c1a7e-...",   // 采集机器；v1 只有一台开启，但要能追溯来源
  "captured_at": "2026-09-21T02:30:00Z",
  "windows": [
    { "window_kind": "five_hour", "utilization_pct": 62.0, "resets_at": "2026-09-21T10:30:00Z" },
    { "window_kind": "seven_day",  "utilization_pct": 41.0, "resets_at": "2026-09-24T01:00:00Z" }
  ],
  "raw": { }        // 官方响应原文，原样透传，服务端存 JSONB
}
```

`window_kind` 是**自由字符串**，不做枚举约束 —— 官方字段名尚未实测确认（见 ARCHITECTURE.md §2.2）。

---

## 2. HTTP API

Base: `/v1`。认证：`Authorization: Bearer <machine_token>`。
**例外（不得要求 machine token）**：`POST /v1/enroll`（先有鸡才有蛋）与 `GET /healthz`。
错误统一 `{"error": {"code": "...", "message": "..."}}`。

**`POST /v1/ingest/events` 请求头**：
```
Content-Type: application/x-ndjson
Content-Encoding: gzip
Idempotency-Key: <批次内容的 sha256 前 32 位>
```

**错误码语义（探针据此决定重试还是丢弃，务必遵守）**：

| 状态码 | 含义 | 探针行为 |
|---|---|---|
| `400` | 报文格式错误，重试多少次都不会被接受 | **丢弃该批并告警** |
| `401` / `403` | 鉴权失败 | 退避重试，提示重新 enroll |
| `429` | 限流，应带 `Retry-After` | 按该头退避 |
| `5xx` | 服务端故障 | 指数退避重试 |

`error.code` 取值（客户端据此区分"凭证失效"与"服务端挂了"，不要只看 HTTP 状态码）：
`bad_request` · `unauthorized` · `machine_revoked` · `not_found` · `rate_limited` · `internal`

`not_found` 专指路由或资源不存在。不要用 `bad_request` 代替 —— 看板调试时会误导人以为是参数错了。

其余 4xx 一律按"永不接受"处理并丢弃 —— 否则一批坏数据会永久堵住队列头，后面正常事件全发不出去。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/ingest/events` | body: gzip NDJSON，每行一个 UsageEvent。→ `200 {"accepted":N,"deduped":M,"invalid":K}`（`invalid` = 跳过的坏行；坏行不得毁掉整批） |
| `POST` | `/v1/ingest/quota` | body: QuotaSnapshot JSON → `200 {"ok":true}` |
| `POST` | `/v1/enroll` | body: `{"enroll_token","hostname","os","provisional_machine_id"}` → `200 {"machine_id","machine_token"}` |
| `GET` | `/v1/profiles` | → `{"profiles":[{"id","kind","label","account_uuid","base_url","plan"}]}`（注意键是 `id` 不是 `profile_id`） |
| `GET` | `/v1/machines` | **全局**清单（不按 profile 过滤——一台机器可给多个 profile 上报）。→ `{"machines":[{"machine_id","label","hostname","os","last_seen_at","revoked":false}]}`。被吊销的机器照常列出并带 `revoked:true`，隐藏会让人以为机器凭空消失 |
| `GET` | `/v1/windows/current?profile_id=` | 当前 5h/7d 窗口状态 + 预测（见 2.1） |
| `GET` | `/v1/timeline?profile_id=&from=&to=` | 甘特图数据：每机器的活跃区间 |
| `GET` | `/v1/distribution?profile_id=&from=&to=&by=machine\|model\|project\|hour\|attribution&bucket=none\|hour\|day` | 分布聚合；`bucket` 缺省 `none` |
| `GET` | `/v1/calibration?profile_id=` | 标定结果：limit 估计、模型权重、残差、观测点数 |
| `GET` | `/v1/summary?profile_id=` | 菜单栏 app 用的精简摘要（见 2.2） |
| `GET` | `/v1/stream?profile_id=` | SSE。`event: window_update` → data 与 `/v1/windows/current` 同体；`event: event_batch` → `{"profile_id","count","last_ts"}`；`event: ping` → `{}` 心跳 |
| `GET` | `/healthz` | → `200 "ok"` |

### 2.1 `GET /v1/windows/current`

```jsonc
{
  "profile_id": "claude-official",
  "windows": [{
    "window_kind": "five_hour",
    "utilization_pct": 62.0,
    "resets_at": "2026-09-21T10:30:00Z",
    "starts_at": "2026-09-21T05:30:00Z",
    "projected_pct": { "p25": 75.0, "mid": 87.0, "p75": 99.0 },
    "exhaust_eta": "2026-09-21T08:42:00Z",   // null 表示本窗口不会耗尽
    "rate_pct_per_min": 0.21,
    "burn_curve": [ { "ts": "...", "pct": 3.0, "source": "official" } ],
    "captured_at": "2026-09-21T02:30:00Z",    // 最近一次额度快照的采集时刻
    "stale": false,                            // 超过 15 分钟没有新快照
    "metrics": {                               // ARCHITECTURE §7.5 的四个重叠度指标
      "local_window_offset_min": 3,             // 分钟，可为负
      "multi_machine_overlap_pct": 34.0,        // ★ 0..100
      "session_cut_rate_pct": 18.0,             // ★ 0..100
      "window_waste_pct": 22.0                  // ★ 0..100
    },
    "projected_curve": [                        // ★ 预测曲线，由服务端算，前端不得自行外推
      { "ts": "...", "p25": 63.0, "mid": 64.2, "p75": 66.1 }
    ]
  }]
}
```

**`projected_curve` 必须由服务端计算，前端不得自行外推。** 原因：5h 窗口是线性速率外推（§7.1），但 **7d 窗口按 §7.2 用的是「按星期几的日历模式」**，线性外推会系统性偏离。曲线从 `now` 开始、到窗口结束，点密度与 `burn_curve` 一致。

**`burn_curve` 的点必须可区分来源。** v1 只放官方快照点（5 分钟一个），`source` 恒为 `"official"`。日后若用本地 token 在采样点之间插值（ARCHITECTURE §7.1 提过，**目前未实现**），插值点必须标 `source: "interpolated"` —— 否则看板会把推算出来的曲线当成官方数据展示。

### 2.1a 其余查询端点的响应形状

```jsonc
// GET /v1/timeline
{ "profile_id": "...", "from": "...", "to": "...",
  "window_boundaries": ["2026-09-21T10:30:00Z"],
  "lanes": [ { "machine_id": "...", "machine_label": "mbp-local",   // 可读名，取自 enroll 的 hostname
               "events": 128, "tokens": 91234,
               "spans": [ { "from": "...", "to": "...", "events": 12, "tokens": 8123 } ] } ],
  "metrics": { "local_window_offset_min": 3, "multi_machine_overlap_pct": 34.0,
               "session_cut_rate_pct": 18.0, "window_waste_pct": 22.0 } }

// GET /v1/distribution?by=machine|model|project|hour|attribution[&bucket=hour|day]
//   by=attribution 时 key 取 attribution_level（proxy|timeline|fallback|unknown）
//   by=hour 时 key 是**小时起点的 RFC3339 时刻**（UTC），不是 0..23 的序号 —— 热力图要靠它分星期
//   bucket=hour|day 时每个 bucket 额外带 series[]，用于「24 小时堆叠柱」这类二维图
//
//   ★ key 与 label 的分工（直接决定跨图表配色是否一致）：
//     key   = 稳定的机器可读标识，**跨端点必须一致**。分类色板一律按 key 登记，不得按 label。
//     label = 展示文案，可缺省（缺省时前端显示 key）。
//     by=machine     → key = machine_id（与 /v1/timeline 的 lanes[].machine_id 同源）， label = machine_label
//     by=model       → key = 模型名，label 缺省
//     by=project     → key = project_slug（可能是 HMAC 化的），label = 可读别名
//     by=hour        → key = 小时起点的 RFC3339 时刻，label 缺省
//     by=attribution → key = attribution_level，label 缺省
{ "profile_id": "...", "by": "machine", "from": "...", "to": "...",
  "buckets": [ { "key": "9f2c1a7e-...", "label": "mbp-local", "events": 128,
                 "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
                 "cache_write_5m_tokens": 0, "cache_write_1h_tokens": 0, "total_tokens": 0,
                 "cost_usd": null,             // null = 该桶无任何有报价的模型
                 "unpriced_events": 12,        // >0 = 成本不完整，前端必须与「成本为 0」区分开
                 "series": [ { "ts": "2026-09-21T13:00:00Z", "total_tokens": 8123, "events": 12,
                                "cost_usd": 0.4213, "unpriced_events": 0 } ] } ] }
//   series 仅在 bucket=hour|day 时出现

// GET /v1/calibration
{ "profile_id": "...",
  "calibrations": [ { "window_kind": "five_hour", "computed_at": "...",
                      "limit_weighted_tokens": 5810000, "base_model": "claude-sonnet-5",
                      "weights": { "claude-opus-5": 3.1 },
                      "residual": 0.032, "observations": 47, "converged": true,
                      "points": [ { "weighted_tokens": 128400, "delta_pct": 2.21, "fitted_pct": 2.18 } ] } ] }
//   points = 逐观测点，供「拟合散点」图使用；没有它「观测点 47 个」只是个数字，看不出拟合好坏
// calibrations 为空数组 = 观测点不够，看板显示「标定中」并退回百分比口径
```

### 2.2 `GET /v1/summary`（菜单栏专用，保持极简）

```jsonc
{
  "profile_id": "claude-official",   // 回显：配错 id 时不能静默返回默认 profile 的数字
  "tray_title_pct": "62%",           // ★ 只含百分比部分，见下
  "windows": [
    { "window_kind": "five_hour",    // 稳定 key，用于排序与记忆折叠状态
      "label": "5h",                 // 展示文案，仅供显示
      "pct": 62, "projected_pct": 87,
      "resets_at": "...",
      "exhaust_eta": "2026-09-21T08:42:00Z" }   // 每个窗口各自的耗尽时刻；null = 本窗口打不满
  ],
  "soonest_exhaust": { "window_kind": "five_hour", "eta": "2026-09-21T08:42:00Z" },
  "captured_at": "2026-09-21T02:30:00Z",   // 额度快照的采集时刻，不是本次请求时刻
  "stale": false,                          // 超过 15 分钟没有新快照
  "rate_pct_per_min": 0.21,
  "dashboard_url": "https://ua.example.com"
}
```

**`tray_title_pct` 的构成规则**：服务端只渲染**百分比部分**（最吃紧窗口的已用百分比）。
**倒计时必须由客户端从 `exhaust_eta` 本地计算并自行每分钟刷新** —— 服务端渲染的倒计时在两次轮询之间就过期了（30~60s 误差），托盘上挂一个慢一分钟的数字比不显示更糟。

`stale` 与 `captured_at` 并存：布尔给快速判断，时间戳让客户端能说出「数据 23 分钟前」—— 用本地拉取时刻近似，衡量的是网络新鲜度而非额度新鲜度，两者不能混。

### 2.3 machine_id 的归属权

**服务端是权威。** 探针 `install` 时先本地生成一个 `provisional_machine_id`（randomUUID）以便离线可用，enroll 时一并提交；服务端返回的 `machine_id` **覆盖**本地值并持久化。此后所有上报只用服务端下发的那个。

未 enroll 就直接上报的探针，服务端应返回 `401`。

---

## 3. 数据库

Postgres 17。迁移文件 `deploy/migrations/NNNN_name.sql`，只增不改。

表：`profiles` / `machines` / `usage_events` / `quota_snapshots` / `calibrations` / `usage_hourly`(物化视图)。
完整 DDL 见 `deploy/migrations/0001_init.sql`（由 ua-server 负责编写，以本文 §1 的字段为准）。

关键约束：
- `usage_events` 主键 `(message_id, request_id)`
- 所有时间列 `TIMESTAMPTZ`，统一 UTC
- 金额 `NUMERIC(12,6)`，**不要用 float**

---

## 4. 约定

- 时间一律 UTC，RFC3339，序列化带 `Z`
- 所有 token 计数 `i64`，非负
- 百分比是 `0..100` 的 f64，**不是 0..1**。**凡是比例/百分比字段，名字一律以 `_pct` 结尾**（`multi_machine_overlap_pct`、`session_cut_rate_pct`…），不带后缀的数值字段一律不是百分比。`@ua/core` 内部函数返回 0..1 的比值，**转成线格式时必须 ×100**
- 探针配置：`~/.config/ua-probe/config.toml`；凭证**绝不上报**
- 日志：结构化，`pino`
- 不得把 prompt / 响应正文 / 工具参数写入任何上报或日志
- **`<synthetic>` 模型的过滤责任在服务端**：探针原样上报不丢数据（实测 43 条），服务端在计费与限额统计中排除，但保留原始行以便审计。模型名归一化同理——探针传原值，服务端用 `@ua/core` 的 `normalizeModel()` 处理
