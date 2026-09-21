-- UsageAccumulator 初始 schema
-- 字段以 docs/CONTRACT.md §1 为准；设计背景见 docs/ARCHITECTURE.md §4 / §6.2。
-- 迁移文件只增不改。

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- profiles：CONTRACT §1 / ARCHITECTURE §4.1
-- OAuth 订阅与 API key 网关在计量语义上根本不同，所以 profile 是一等公民，
-- 看板按 profile 切换视图，绝不跨 profile 求和。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id           TEXT PRIMARY KEY,                       -- 'claude-official' / 'gw-openrouter'
  kind         TEXT NOT NULL DEFAULT 'oauth',          -- 'oauth' | 'api_key'（自由字符串，不加枚举约束）
  label        TEXT NOT NULL DEFAULT '',
  account_uuid TEXT,                                   -- OAuth：对应 ownerAccountUuid
  base_url     TEXT,                                   -- API key：自定义网关地址
  plan         TEXT,                                   -- 'max_20x' 等，决定限额基准
  owner_id     TEXT,                                   -- 预留，v1 不实现 RBAC（ARCHITECTURE §1 非目标）
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- machines：enroll 换取的长期 machine token，可单独吊销（ARCHITECTURE §9）
-- 明文 token 绝不入库，只存 sha256。
-- ─────────────────────────────────────────────────────────────────────────────
-- machine_id 的归属权在服务端（CONTRACT §2.3）：探针本地先生成 provisional_machine_id
-- 以便离线可用，enroll 时提交；服务端下发权威 id 覆盖它。这里把探针提交的那个也留下，
-- 纯为排障时能把两边的日志对上。
CREATE TABLE IF NOT EXISTS machines (
  id           TEXT PRIMARY KEY,                       -- 服务端下发的权威 machine_id（UUID，非主机名）
  provisional_machine_id TEXT,                         -- 探针 enroll 时提交的本地临时 id，仅供追溯
  hostname     TEXT,
  os           TEXT,
  token_sha256 TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS machines_token_sha256_uidx ON machines (token_sha256);

-- ─────────────────────────────────────────────────────────────────────────────
-- usage_events：CONTRACT §1.1 / §3、ARCHITECTURE §4.5
--
-- 主键 (message_id, request_id) —— CONTRACT §3 的硬性约束。
-- 实测有 519 条行缺 requestId，所以 request_id 允许为**空字符串**（不是 NULL，
-- NULL 不能进主键）。此时主键退化为 (message_id, '')：message_id 本身已是
-- 每条 assistant 消息的唯一标识，同 message_id 的多次落盘正是要去掉的那 64% 重复，
-- 所以这一退化仍然是正确的去重。
--
-- 另加 semantic_id 兜底（CONTRACT §1.2）：对 request_id 为空的行建**部分唯一索引**，
-- 于是 message_id 也异常（如被套壳改写）时仍有第二道去重。
-- 插入用不带冲突目标的 ON CONFLICT DO NOTHING，两个约束都能吃掉重复。
--
-- 内容隐私：本表刻意没有任何存放 prompt / 响应正文 / 工具参数的列（ARCHITECTURE §9）。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usage_events (
  message_id            TEXT NOT NULL,
  request_id            TEXT NOT NULL DEFAULT '',
  semantic_id           TEXT NOT NULL,
  machine_id            TEXT NOT NULL,
  app_type              TEXT NOT NULL DEFAULT 'claude',
  profile_id            TEXT NOT NULL,
  attribution_level     TEXT NOT NULL DEFAULT 'unknown',   -- proxy|timeline|fallback|unknown
  ts                    TIMESTAMPTZ NOT NULL,
  model                 TEXT NOT NULL,
  input_tokens          BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens          >= 0),
  output_tokens         BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens         >= 0),
  thinking_tokens       BIGINT NOT NULL DEFAULT 0 CHECK (thinking_tokens       >= 0),
  cache_read_tokens     BIGINT NOT NULL DEFAULT 0 CHECK (cache_read_tokens     >= 0),
  -- ★ 5m 与 1h 必须分开：单价不同，实测 87.8% 的缓存写入是 1h，合并会系统性算错钱
  cache_write_5m_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_write_5m_tokens >= 0),
  cache_write_1h_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_write_1h_tokens >= 0),
  session_id            TEXT NOT NULL DEFAULT '',
  project_slug          TEXT,
  git_branch            TEXT,
  entrypoint            TEXT,
  service_tier          TEXT,
  is_sidechain          BOOLEAN NOT NULL DEFAULT false,
  backfill              BOOLEAN NOT NULL DEFAULT false,
  -- NULL = 该模型没有报价，**不是 0**。定价表从 deploy/pricing.json 注入，
  -- 代码里不写死任何价格（见 packages/ua-core/src/pricing.ts 的注释）。
  cost_usd              NUMERIC(12,6),
  ingested_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- '<synthetic>' 是 Claude Code 的合成标记（实测 43 条），必须排除在计费与限额统计外
  counts_toward_quota   BOOLEAN NOT NULL GENERATED ALWAYS AS (model <> '<synthetic>') STORED,

  CONSTRAINT usage_events_message_id_not_blank CHECK (message_id <> ''),
  PRIMARY KEY (message_id, request_id)
);

-- request_id 缺失时的第二道去重（CONTRACT §1.2 的 semantic_id 兜底）
CREATE UNIQUE INDEX IF NOT EXISTS usage_events_semantic_fallback_uidx
  ON usage_events (semantic_id) WHERE request_id = '';

CREATE INDEX IF NOT EXISTS usage_events_profile_ts_idx  ON usage_events (profile_id, ts DESC);
CREATE INDEX IF NOT EXISTS usage_events_ts_idx          ON usage_events (ts DESC);
CREATE INDEX IF NOT EXISTS usage_events_machine_ts_idx  ON usage_events (profile_id, machine_id, ts DESC);
CREATE INDEX IF NOT EXISTS usage_events_session_idx     ON usage_events (profile_id, session_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- quota_snapshots：CONTRACT §1.3 / ARCHITECTURE §4.4
--
-- window_kind 按**自由字符串**存，刻意不建枚举约束 —— 官方字段名尚未实测确认
-- （ARCHITECTURE §2.2：Claude-Usage-Tracker 写的 seven_day_opus 很可能已改名）。
-- 改名时表结构不受影响，raw 里还留着原文可以回溯重算。
--
-- 口径：utilization_pct 是 0..100（CONTRACT §4），不是 ARCHITECTURE §4.4 草稿里的 0..1。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quota_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  profile_id      TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- 采集机器（CONTRACT §1.3）。v1 只有一台开启 QuotaFetcher，但快照来源必须可追溯：
  -- 两台机器抓到不一致的百分比时，没有这一列就查不下去。不加外键，采集机可能尚未 enroll。
  machine_id      TEXT,
  captured_at     TIMESTAMPTZ NOT NULL,
  window_kind     TEXT NOT NULL,
  utilization_pct DOUBLE PRECISION CHECK (utilization_pct IS NULL OR (utilization_pct >= 0 AND utilization_pct <= 100)),
  resets_at       TIMESTAMPTZ,
  raw             JSONB NOT NULL DEFAULT '{}'::jsonb,   -- 官方响应原文，字段改名后可回溯重算
  UNIQUE (profile_id, window_kind, captured_at)
);
CREATE INDEX IF NOT EXISTS quota_snapshots_lookup_idx
  ON quota_snapshots (profile_id, window_kind, captured_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- calibrations：ARCHITECTURE §7.0（百分比 → 绝对限额的非负最小二乘反解）
-- 只增不改，保留历史；官方调限额时残差会突然变大，对比历史即可发现。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calibrations (
  id                    BIGSERIAL PRIMARY KEY,
  profile_id            TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  window_kind           TEXT NOT NULL,
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  limit_weighted_tokens DOUBLE PRECISION NOT NULL,
  base_model            TEXT NOT NULL,
  weights               JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { model: w_m }，基准模型为 1
  residual              DOUBLE PRECISION NOT NULL,            -- 相对残差 ‖Ax−b‖/‖b‖
  observations          INTEGER NOT NULL,
  converged             BOOLEAN NOT NULL DEFAULT false,
  -- 逐观测点 [{weighted_tokens, delta_pct, fitted_pct}]，供看板画拟合散点。
  -- 存下来而不是查询时重算：重算会用「现在的事件」去配「当时的拟合」，
  -- 补报的历史事件一进来，散点就和残差对不上了。
  points                JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS calibrations_lookup_idx
  ON calibrations (profile_id, window_kind, computed_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- usage_hourly：profile × machine × model × hour 预聚合（ARCHITECTURE §6.2）
-- 看板的分布查询走这里，原始表只用于回溯重算。
-- 用 REFRESH MATERIALIZED VIEW CONCURRENTLY 刷新，因此必须有唯一索引。
--
-- 刻意保留 '<synthetic>' 行并用 counts_toward_quota 标记，而不是在视图里丢掉：
-- 丢掉就再也看不出合成事件有多少了。过滤在查询侧做。
-- ─────────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS usage_hourly AS
SELECT
  profile_id,
  machine_id,
  model,
  date_trunc('hour', ts)                                  AS hour,
  (model <> '<synthetic>')                                AS counts_toward_quota,
  count(*)                                                AS events,
  count(DISTINCT session_id)                              AS sessions,
  sum(input_tokens)                                       AS input_tokens,
  sum(output_tokens)                                      AS output_tokens,
  sum(thinking_tokens)                                    AS thinking_tokens,
  sum(cache_read_tokens)                                  AS cache_read_tokens,
  sum(cache_write_5m_tokens)                              AS cache_write_5m_tokens,
  sum(cache_write_1h_tokens)                              AS cache_write_1h_tokens,
  sum(input_tokens + output_tokens + cache_read_tokens
      + cache_write_5m_tokens + cache_write_1h_tokens)    AS total_tokens,
  -- 有报价的部分求和；无报价的条数单独计，前端据此显示「成本不完整」而不是假装是 0
  sum(cost_usd) FILTER (WHERE cost_usd IS NOT NULL)       AS cost_usd,
  count(*)      FILTER (WHERE cost_usd IS NULL)           AS unpriced_events
FROM usage_events
GROUP BY profile_id, machine_id, model, date_trunc('hour', ts);

CREATE UNIQUE INDEX IF NOT EXISTS usage_hourly_uidx
  ON usage_hourly (profile_id, machine_id, model, hour);
CREATE INDEX IF NOT EXISTS usage_hourly_hour_idx ON usage_hourly (hour DESC);

COMMIT;
