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
  "output_final": true,                          // output_tokens 是否为最终值；false = 只是下界；旧探针不报 → 服务端存 null
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
| `output_final` | `message.stop_reason` 非空，或 `message.usage` 带 `iterations` |

> **同一条消息在 JSONL 里有多行**（按 content block 拆开写），input / cache 各行相同，`output_tokens` 只增不减。主线会话每行都是最终值；**子代理转录只有最后一行是最终值**，前面各行是流式中途值（实测 2~7），而且很多子代理消息根本没写出最终行（2026-10-02 实测 NAS 一个 Workflow 会话 3905 条里 2055 条）。所以 `output_final = false` 的 `output_tokens` 与成本都只是**下界**。
>
> `cache_creation_input_tokens` 是 5m + 1h 的**总和**，仅作校验用，不入库。若 `cache_creation` 对象缺失，退化为全部计入 `cache_write_5m_tokens` 并记一条 warn。

### 1.2 去重

主键 `(message_id, request_id)`。任一缺失时用 `semantic_id` 兜底：

```
semantic_id = sha256(session_id | ts_ms | model | input | output | cache_read | cache_write_5m | cache_write_1h)[:32]
```

**`message_id` 恒非空。** 实测 29,198 条真实事件中 `message_id` 为空 **0 条**、两者同时为空 **0 条**，因此主键 `(message_id, request_id)` 不会全局撞车。探针解析出空 `message_id` 时**丢弃该事件并告警**，不得上报；服务端收到空 `message_id` 一律 `400`。

**线格式规定**：`semantic_id` **永远填写**，不因 `request_id` 存在而省略。`request_id` 缺失时填空字符串 `""`，不要填 null、不要拿 semantic_id 冒充 request_id。服务端据此选择主键路径。

**同一个键可能被报多次**：ssh 场景下多台机器各报一份；同一条消息的多行也是同一个键（见 1.1）。两处去重（探针本地队列、服务端入库）都按「用量更完整」取大，**不是先到先得**：

```
usage_rank = output_tokens × 3 + (output_final 为 true → 2，false → 1，null → 0)
```

服务端对有 `request_id` 的行 `ON CONFLICT (message_id, request_id) DO UPDATE`：新来的 `usage_rank` 更大时覆盖全部 token 列、`output_final` 与 `cost_usd`，其余列（`machine_id`、`profile_id` 等）仍归先到的那份。`request_id` 为空的语义兜底行仍是 `DO NOTHING`——`semantic_id` 里含 output，同一条消息的不同行本来就是不同的键。

实测口径（见 ARCHITECTURE §2.0）：28,794 条原始事件去重后剩 10,423 条，**64% 是重复**；其中跨机重复仅 441 条。探针会先在本地去重一轮（实测吃掉 56%），服务端仍须自己再去一次，不得假设上游已去干净。

### 1.3 QuotaSnapshot（探针 → 服务端；默认由服务端自己抓，见 2.4）

```jsonc
{
  "profile_id": "claude-official",
  "machine_id": "9f2c1a7e-...",   // 可省略：服务端以上报用的 machine token 为准记录来源
  "captured_at": "2026-09-21T02:30:00Z",
  "windows": [
    { "window_kind": "five_hour", "utilization_pct": 62.0, "resets_at": "2026-09-21T10:30:00Z" },
    { "window_kind": "seven_day",  "utilization_pct": 41.0, "resets_at": "2026-09-24T01:00:00Z" }
  ],
  "raw": { }        // 官方响应原文，原样透传，服务端存 JSONB
}
```

`window_kind` 是**自由字符串**，不做枚举约束 —— 官方字段名尚未实测确认（见 ARCHITECTURE.md §2.2）。

入库时 `quota_snapshots.machine_id` 记的是**上报者的鉴权身份**，不是 body 里的字段；留空专指「服务端自己抓的」（2.4）。

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
`bad_request` · `unauthorized` · `forbidden` · `machine_revoked` · `not_found` · `rate_limited` · `upstream` · `internal`

`upstream` 专指服务端去问第三方（目前只有 claude.ai）时对方出了问题：连不上、被 Cloudflare 质询。探针不会遇到它。

`not_found` 专指路由或资源不存在。不要用 `bad_request` 代替 —— 看板调试时会误导人以为是参数错了。

其余 4xx 一律按"永不接受"处理并丢弃 —— 否则一批坏数据会永久堵住队列头，后面正常事件全发不出去。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/v1/ingest/events` | body: gzip NDJSON，每行一个 UsageEvent。→ `200 {"accepted":N,"updated":U,"deduped":M,"invalid":K}`（`updated` = 库里已有、这次用量更完整而被覆盖的；`invalid` = 跳过的坏行；坏行不得毁掉整批） |
| `POST` | `/v1/ingest/quota` | body: QuotaSnapshot JSON → `200 {"ok":true}` |
| `POST` | `/v1/enroll` | body: `{"enroll_token","hostname","os","provisional_machine_id"}` → `200 {"machine_id","machine_token"}` |
| `GET` | `/v1/profiles` | → `{"profiles":[{"id","kind","label","account_uuid","base_url","plan","org_uuid","active"}]}`（注意键是 `id` 不是 `profile_id`）。`active` 恰有一个为 `true`：最近有用量的那个。**所有带 `profile_id` 参数的接口**在不传它、且 profile 多于一个时回落到 active，不再 400 |
| `GET` | `/v1/machines` | **全局**清单（不按 profile 过滤——一台机器可给多个 profile 上报）。→ `{"machines":[{"machine_id","label","hostname","os","last_seen_at","revoked":false}]}`。被吊销的机器照常列出并带 `revoked:true`，隐藏会让人以为机器凭空消失 |
| `GET` | `/v1/windows/current?profile_id=&burn_points=` | 当前 5h/7d 窗口状态 + 预测（见 2.1）。`burn_points`（2–240，缺省 240）限制燃尽 / 预测曲线的点数，只要数字的客户端传 2 |
| `GET` | `/v1/timeline?profile_id=&from=&to=` | 甘特图数据：每机器的活跃区间 |
| `GET` | `/v1/distribution?profile_id=&from=&to=&by=machine\|model\|project\|hour\|attribution&bucket=none\|hour\|day` | 分布聚合；`bucket` 缺省 `none` |
| `GET` | `/v1/calibration?profile_id=` | 标定结果：limit 估计、模型权重、残差、观测点数 |
| `GET` | `/v1/summary?profile_id=` | 菜单栏 app 用的精简摘要（见 2.2） |
| `GET` | `/v1/stream?profile_id=` | SSE。`event: window_update` → data 与 `/v1/windows/current` 同体；`event: event_batch` → `{"profile_id","count","last_ts"}`；`event: ping` → `{}` 心跳 |
| `GET` | `/v1/quota/session?profile_id=` | 服务端抓额度用的 claude.ai 会话**状态**（见 2.4）。任何已鉴权身份可读 |
| `PUT` | `/v1/quota/session` | body: `{"profile_id","session_key"}`，**仅看板身份**。先验后存 → 状态（见 2.4） |
| `DELETE` | `/v1/quota/session?profile_id=` | 删除会话，**仅看板身份** → 状态 |
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
    ],
    "attribution": {                            // 有多少额度不是本地 Claude Code 吃的
      "other_pct_lower_bound": 4.0,             // 差额法：安静区间里的上升（下界）
      "ambiguous_pct": 50.0,                    // 差额法判不了的（本地当时有活动）
      "unobserved_pct": 0.0,                    // 窗口开头没采到的
      "quiet_spans": 2, "has_sampling_gap": false, "usable": true,
      "non_code_pct": 2.6,                      // 官方拆分的非 Code 用量，折成本窗口刻度；拿不到为 null
      "other_pct": 5.1,                         // 最佳估计：7d = non_code_pct；5h = 两者合成；没有拆分 = 下界
      "local_utilization_pct": 56.9             // = utilization_pct − other_pct，「满额约」的分母
    }
  }],
  "products": {                                 // 官方「本周按产品」拆分；team 组织没有，为 null
    "as_of": "2026-09-29T03:54:23Z",
    "weekly_pct": 9.0,                          // 这份拆分那一刻的 7d 利用率
    "rows": [
      { "key": "claude_code", "label": "Claude Code", "share_pct": 97, "pct": 8.73 },  // share 占本周已用量（官方整数）
      { "key": "chat",        "label": "Chats",       "share_pct": 3,  "pct": 0.27 }   // pct 占周限额 = weekly × share / 100
    ]
  }
}
```

**非本地用量的两条路径**（算法见 `@ua/core` 的 `attribution.ts` / `products.ts`）：

| 窗口 | `other_pct` 怎么来 |
|---|---|
| 7d，有拆分 | 直接等于 `non_code_pct`。7d 一格就是 1 个整点，安静时段里零点几的聊天就能把计数推过整数线，差额法会把整点记到别处 |
| 5h，有拆分 | `max(non_code_pct, 差额法下界 + 拆分在「判不了」区间里的部分)`。5h 没有官方拆分，`non_code_pct` = 周刻度的非 Code 增量 × 历史估出的 5h/7d 刻度比（Max 5x 实测约 9.4） |
| 没有拆分（team 组织） | 等于 `other_pct_lower_bound`，与以前一致 |

周刻度的非 Code 累计量要先做单调拟合（PAVA）再相减：份额是整数，Code 在涨、聊天没动时份额会被稀释，直接相减会得到负数。

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
//     by=session     → key = session_id，label = 会话标题；另带 project_slug / machine_label / session_count。
//                      桌面端每恢复一次会话就换一个 id 并复制标题：同标题 + 同项目 + 同机器的几个 id
//                      合成一桶，key 取其中最早出现的那个，session_count = 合并了几个 id（没标题的不合并）
{ "profile_id": "...", "by": "machine", "from": "...", "to": "...",
  "buckets": [ { "key": "9f2c1a7e-...", "label": "mbp-local", "events": 128,
                 "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
                 "cache_write_5m_tokens": 0, "cache_write_1h_tokens": 0, "total_tokens": 0,
                 "cost_usd": null,             // null = 该桶无任何有报价的模型
                 "unpriced_events": 12,        // >0 = 成本不完整，前端必须与「成本为 0」区分开
                 "partial_output_events": 3,   // >0 = 有事件的 output_final = false，output_tokens 与 cost_usd 都是下界
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


### 2.4 `/v1/quota/session`（服务端直接抓额度）

额度默认由**服务端**每 5 分钟（+ 最多 1 分钟抖动）直接向 claude.ai 抓取，不再依赖某台机器上的探针在线（ARCHITECTURE §5.3）。
为此服务端要持有一份 claude.ai 会话（浏览器 Cookie 里的 `sessionKey`）。

```jsonc
// GET / PUT / DELETE 的响应同形 —— 只有状态，任何接口都不回显 sessionKey
{
  "profile_id": "claude-official",
  "state": "ok",               // none | pending | ok | auth | blocked | org | error | disabled
  "last_ok_at": "2026-09-23T12:05:00Z",
  "last_attempt_at": "2026-09-23T12:05:00Z",
  "next_attempt_at": "2026-09-23T12:10:31Z",
  "error": null,                // 给人看的失败原因，绝不含凭证
  "org_uuid": "c702d391-…",     // 这个 profile 绑定的 claude.ai 组织；没绑为 null
  "orgs": [                     // 这个会话能看到的组织；还没问过 claude.ai 时为 null
    { "uuid": "c702d391-…", "name": "…", "plan": "max_5x", "bound_to": "claude-official" },
    { "uuid": "29c62b23-…", "name": "Kimmy Inc.", "plan": "team", "bound_to": "claude-team" }
  ]
}
```

| state | 含义 | 服务端行为 |
|---|---|---|
| `none` | 没保存会话 | 不抓 |
| `pending` | 存了、还没抓过 | 下一轮（≤30 秒）抓 |
| `ok` | 最近一次成功 | 按间隔继续 |
| `auth` | claude.ai 不认这个会话 | 退避 15 分钟 → 1 小时 → 6 小时，等人重新登录 |
| `blocked` | 被 Cloudflare 质询 | 同样退避；换会话也没用 |
| `org` | 会话有效，但不知道抓哪个组织：账号下有多个、或绑定的那个已不在 | 不抓，按正常间隔再看；等看板选组织 |
| `error` | 网络 / 5xx / 响应变形 | 下一轮照常重试，不进退避阶梯 |
| `disabled` | 服务端关了采集（`UA_QUOTA_SAMPLING=false`） | 只收探针上报；PUT / DELETE 返回 `404` |

**PUT 先验后存**：服务端先用它请求 `GET /api/organizations`，claude.ai 认了才落盘并立刻抓一次，
所以响应里的 `state` 通常已经是 `ok`。不认 → `400 bad_request`（不会顶掉原来那个好的）；
连不上或被质询 → `502 upstream`。
格式明显不对（短于 16、含空白或非 ASCII）直接 `400`，不去问 claude.ai。

**组织绑定**：profile 对应的是**一个组织**（一份订阅），不是一个账号 —— 同一个 sessionKey 可以同时看到
team 组织与个人订阅组织，两边额度毫不相干（2026-09-27 实测：个人 Max 组织不带 `raven` 能力，按能力猜会选中 team）。
绑定存在 `profiles.org_uuid`（唯一），服务端**不猜**：已绑定的沿用；没绑定且只有一个无歧义候选时自动绑；
否则进入 `org` 状态。PUT body 为 `{"profile_id","session_key"?,"org_uuid"?}`，二者至少给一个：
只给 `org_uuid` 表示沿用已保存的会话、只换组织。组织不在该会话的列表里、或已绑到别的 profile → `400`。
多个 profile 可以各存一份同样的 sessionKey，各抓各的组织。

**存放**：`UA_CLAUDE_SESSION_DIR` 下一个 profile 一个文件（目录 0700、文件 0600），**不进数据库**。
服务端每一轮都重新读文件，所以在机器上直接覆盖它也立刻生效，退避随之清零。

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
