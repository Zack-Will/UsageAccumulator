/**
 * Mock 数据源 —— 结构严格按 CONTRACT §2 / §2.1 / §2.1a。
 * 服务端未就绪时前端靠它独立推进；切换见 src/api/index.ts。
 *
 * 刻意覆盖的几种「难看但真实」的状态：
 *   · 定价表已填好（28 个模型），但表外模型仍然返回 cost_usd = null
 *     → 「成本未知」这条 UI 分支必须一直走得到，所以 mock 保留缺价用例
 *   · burn_curve 全是 official 点（v1 语义）
 *   · 7d 的 projected_curve 是**日历模式**（周末塌下去），不是直线 ——
 *     前端照画即可，这正是「前端不得自行外推」的理由
 *   · calibration 只对 five_hour 收敛，七天窗口观测点不够（不出现在数组里）
 */
import type {
  BucketGranularity,
  BucketSeriesPoint,
  Calibration,
  CalibrationEntry,
  CalibrationPoint,
  Distribution,
  DistributionBucket,
  DistributionParams,
  Machine,
  Profile,
  ProjectedCurvePoint,
  QuotaHistory,
  QuotaHistoryParams,
  QuotaSample,
  StreamEvent,
  TimeRangeParams,
  Timeline,
  TimelineLane,
  TimelineSpan,
  UaApi,
  WindowState,
  WindowsCurrent,
} from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();
const clampPct = (v: number): number => Math.max(0, Math.min(100, v));

export const MOCK_PROFILES: Profile[] = [
  {
    id: "claude-official",
    kind: "oauth",
    label: "Claude 官方订阅",
    account_uuid: "b14c8d02-91ef-4a77-8c31-2f6d90a4e115",
    base_url: null,
    plan: "max_20x",
  },
  {
    id: "gw-anyrouter",
    kind: "api_key",
    label: "Anyrouter 网关",
    account_uuid: null,
    base_url: "https://anyrouter.example.com",
    plan: null,
  },
];

/** ARCHITECTURE §4.1：machine_id 是探针安装时生成的 UUID；label 来自 enroll 的 hostname。 */
export const MOCK_MACHINES: Machine[] = [
  {
    machine_id: "9f2c1a7e-4b33-4c21-9a70-1d5e8c0b7a44",
    label: "mbp-local",
    hostname: "mbp-local",
    os: "darwin",
    last_seen_at: iso(Date.now()),
    revoked: false,
  },
  {
    machine_id: "3b71d0c4-8f52-4e19-b6c3-7a2e9d10f5b8",
    label: "linux-a",
    hostname: "linux-a",
    os: "linux",
    last_seen_at: iso(Date.now()),
    revoked: false,
  },
  {
    machine_id: "c1e8a552-2d47-4f88-91ac-5b3f7e64c092",
    label: "linux-b",
    hostname: "linux-b",
    os: "linux",
    last_seen_at: iso(Date.now()),
    revoked: false,
  },
  {
    machine_id: "77a0fe19-6c11-4a35-8d72-e40b91c2a6d3",
    label: "vps-tokyo",
    hostname: "vps-tokyo",
    os: "linux",
    last_seen_at: iso(Date.now()),
    revoked: false,
  },
];

/**
 * ARCHITECTURE §2.0 实测取值（`<synthetic>` 由服务端排除，不出现在看板），
 * 外加一个第三方网关自定义的模型名。
 */
const MODELS = [
  "claude-opus-5",
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-4-8",
  "openclaw-fast-1",
] as const;

/**
 * 定价表已经填好（deploy/pricing.json，28 个模型，LiteLLM 程序化生成），
 * 上面四个 claude 模型都在表里。但第三方网关会自造模型名，那些**永远**不在表里 ——
 * 留一个进来，保证「成本未知 / —†」这条 UI 分支不会腐烂。
 */
const UNPRICED_MODELS = new Set<string>(["openclaw-fast-1"]);

const PROJECTS = [
  "-Users-zhouweichuan-Repos-Cleave",
  "-Users-zhouweichuan-Repos-UsageAccumulator",
  "-Users-zhouweichuan-Repos-cc-switch",
  "-Users-zhouweichuan-Repos-atlas",
  "-Users-zhouweichuan-Repos-probe-lab",
  "ssh-4d1c9f20",
  "-Users-zhouweichuan-Repos-notes",
  // hash_project_paths = true 且没配别名的情况：slug 是 HMAC 化的，label 缺省
  "a3f19c04e7b25d81f60c9ab3",
] as const;

/**
 * 5h 窗口起点：固定取「now 往前 3h06m」，让 mock 始终停在一个有看头的窗口中段 ——
 * 剩余 1h54m，预测区间张得开，耗尽 ETA 落在窗口内。
 * 对齐到 5h 栅格的话窗口位置随机，预测带经常退化成一条线，看不出对错。
 */
const FIVE_HOUR_ELAPSED = 3.1 * HOUR;
const fiveHourStart = (now: number): number => now - FIVE_HOUR_ELAPSED;
/** 甘特图的窗口边界按真实的 5h 栅格推。 */
const fiveHourGrid = (now: number): number => Math.floor(now / (5 * HOUR)) * (5 * HOUR);

const MOCK_METRICS = {
  local_window_offset_min: 3,
  multi_machine_overlap_pct: 34.0,
  session_cut_rate_pct: 18.0,
  window_waste_pct: 22.0,
};

function buildBurnCurve(
  startMs: number,
  nowMs: number,
  endPct: number,
  seed: number,
  stepMs: number,
): WindowState["burn_curve"] {
  const r = rng(seed);
  const steps = Math.max(1, Math.round((nowMs - startMs) / stepMs));
  const increments: number[] = [];
  for (let i = 0; i < steps; i++) increments.push((r() < 0.22 ? 0 : 1) * (0.3 + r() * 1.9));
  const total = increments.reduce((a, b) => a + b, 0) || 1;

  const out: WindowState["burn_curve"] = [{ ts: iso(startMs), pct: 0, source: "official" }];
  let pct = 0;
  for (let i = 0; i < steps; i++) {
    pct += ((increments[i] ?? 0) / total) * endPct;
    out.push({
      ts: iso(startMs + (i + 1) * stepMs),
      pct: Math.round(pct * 10) / 10,
      source: "official",
    });
  }
  return out;
}

/**
 * 服务端侧的预测曲线。
 * 五小时窗口走线性速率（§7.1）；七天窗口走日历模式（§7.2）—— 周末的日消耗只有
 * 工作日的 ~40%，所以曲线是分段折线而不是直线。前端照画，不做任何外推。
 */
function buildProjectedCurve(
  kind: string,
  nowMs: number,
  endMs: number,
  used: number,
  target: { p25: number; mid: number; p75: number },
  stepMs: number,
): ProjectedCurvePoint[] {
  const span = Math.max(1, endMs - nowMs);
  const steps = Math.max(1, Math.min(360, Math.round(span / stepMs)));
  const calendar = kind !== "five_hour";

  // 日历权重：把 [now, end] 按天切，周末权重 0.4
  const weightAt = (ms: number): number => {
    if (!calendar) return 1;
    const d = new Date(ms).getDay();
    return d === 0 || d === 6 ? 0.4 : 1;
  };

  // 先累出权重积分，再按积分比例分配增量
  const cum: number[] = [0];
  for (let i = 1; i <= steps; i++) {
    const ms = nowMs + (span * i) / steps;
    cum.push((cum[i - 1] ?? 0) + weightAt(ms));
  }
  const totalW = cum[steps] || 1;

  const out: ProjectedCurvePoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const k = (cum[i] ?? 0) / totalW;
    out.push({
      ts: iso(nowMs + (span * i) / steps),
      p25: Math.round(clampPct(used + (target.p25 - used) * k) * 10) / 10,
      mid: Math.round(clampPct(used + (target.mid - used) * k) * 10) / 10,
      p75: Math.round(clampPct(used + (target.p75 - used) * k) * 10) / 10,
    });
  }
  return out;
}

function makeWindow(
  kind: string,
  nowMs: number,
  spec: { used: number; spanMs: number; startMs: number; rate: number; seed: number; stale?: boolean },
): WindowState {
  const endMs = spec.startMs + spec.spanMs;
  const remainMin = (endMs - nowMs) / MIN;
  const mid = clampPct(spec.used + spec.rate * remainMin);
  const p25 = clampPct(spec.used + spec.rate * 0.62 * remainMin);
  const p75 = clampPct(spec.used + spec.rate * 1.34 * remainMin);
  const etaMin = spec.rate > 0 ? (100 - spec.used) / spec.rate : Infinity;
  // 长窗口用粗一点的采样步长，否则 mock 一个 7d 窗口要造上千个点
  const step = spec.spanMs <= 6 * HOUR ? 5 * MIN : HOUR;

  return {
    window_kind: kind,
    utilization_pct: Math.round(spec.used * 10) / 10,
    starts_at: iso(spec.startMs),
    resets_at: iso(endMs),
    projected_pct: {
      p25: Math.round(p25 * 10) / 10,
      mid: Math.round(mid * 10) / 10,
      p75: Math.round(p75 * 10) / 10,
    },
    // ARCHITECTURE §7.3：projected < limit 时不给窗口结束之后的假时间。
    exhaust_eta: etaMin <= remainMin ? iso(nowMs + etaMin * MIN) : null,
    rate_pct_per_min: Math.round(spec.rate * 100) / 100,
    burn_curve: buildBurnCurve(spec.startMs, nowMs, spec.used, spec.seed, step),
    projected_curve: buildProjectedCurve(kind, nowMs, endMs, spec.used, { p25, mid, p75 }, step),
    captured_at: iso(nowMs - 2 * MIN),
    stale: spec.stale ?? false,
    metrics: { ...MOCK_METRICS },
  };
}

function windowsAt(nowMs: number, drift: number): WindowsCurrent {
  const fiveStart = fiveHourStart(nowMs);
  const sevenStart = nowMs - 4.3 * DAY;
  return {
    profile_id: "claude-official",
    windows: [
      makeWindow("five_hour", nowMs, {
        used: clampPct(58 + drift),
        spanMs: 5 * HOUR,
        startMs: fiveStart,
        rate: 0.4,
        seed: 1013,
      }),
      makeWindow("seven_day", nowMs, {
        used: clampPct(41 + drift * 0.25),
        spanMs: 7 * DAY,
        startMs: sevenStart,
        rate: 0.0044,
        seed: 2029,
      }),
      // ARCHITECTURE §2.2：官方响应里这个字段叫 seven_day_opus，但真正受限的是 Fable；
      // CONTRACT §2.2 的展示标签是 "7d Fable"。§1.3 说 window_kind 是自由字符串，
      // 所以原样透传官方 kind，标签映射放在前端（components/WindowCards.tsx）。
      makeWindow("seven_day_opus", nowMs, {
        used: clampPct(73 + drift * 0.3),
        spanMs: 7 * DAY,
        startMs: sevenStart,
        rate: 0.0046,
        seed: 3041,
      }),
    ],
  };
}

// ── /v1/timeline ────────────────────────────────────────────────────────────
function buildTimeline(p: TimeRangeParams, nowMs: number): Timeline {
  const from = Date.parse(p.from);
  const to = Math.min(Date.parse(p.to), nowMs);
  const boundaries: string[] = [];
  for (let t = fiveHourGrid(from); t <= to; t += 5 * HOUR) {
    if (t > from) boundaries.push(iso(t));
  }

  const lanes: TimelineLane[] = MOCK_MACHINES.map((m, mi) => {
    const r = rng(7001 + mi * 97);
    const spans: TimelineSpan[] = [];
    let t = from + r() * 20 * MIN;
    let events = 0;
    let tokens = 0;
    const busy = [1, 0.66, 0.48, 0.3][mi] ?? 0.4;
    while (t < to) {
      const gap = ((26 + r() * 118) * MIN) / busy;
      const len = (10 + r() * 46) * MIN;
      const start = t + gap;
      const end = Math.min(start + len, to);
      if (start >= end) break;
      const ev = 4 + Math.floor(r() * 40);
      const tk = Math.round(ev * (26_000 + r() * 90_000));
      spans.push({ from: iso(start), to: iso(end), events: ev, tokens: tk });
      events += ev;
      tokens += tk;
      t = end;
    }
    return { machine_id: m.machine_id, machine_label: m.label, events, tokens, spans };
  });

  return {
    profile_id: p.profile_id,
    from: p.from,
    to: p.to,
    window_boundaries: boundaries,
    lanes,
    metrics: { ...MOCK_METRICS },
  };
}

// ── /v1/distribution ────────────────────────────────────────────────────────
/**
 * 造一个桶。priced=false 时 cost_usd 为 null、全部事件计入 unpriced_events。
 */
function bucket(
  key: string,
  events: number,
  totalTokens: number,
  r: () => number,
  priced: boolean,
  partial = false,
  label?: string,
): DistributionBucket {
  const cacheRead = Math.round(totalTokens * (0.52 + r() * 0.26));
  const rest = totalTokens - cacheRead;
  const output = Math.round(rest * (0.18 + r() * 0.12));
  const write1h = Math.round(rest * 0.55); // §2.0 实测：1h 占缓存写入 87.8%
  const write5m = Math.round(rest * 0.08);
  const input = Math.max(0, rest - output - write1h - write5m);
  const unpriced = priced ? (partial ? Math.round(events * (0.02 + r() * 0.06)) : 0) : events;
  return {
    key,
    ...(label === undefined ? {} : { label }),
    events,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_5m_tokens: write5m,
    cache_write_1h_tokens: write1h,
    total_tokens: totalTokens,
    cost_usd: priced ? Math.round(totalTokens * 0.0000042 * 10000) / 10000 : null,
    unpriced_events: unpriced,
  };
}

/** bucket=hour|day 时给桶铺上 series[]。 */
function withSeries(
  b: DistributionBucket,
  from: number,
  to: number,
  granularity: Exclude<BucketGranularity, "none">,
  seed: number,
  shape: (k: number) => number,
): DistributionBucket {
  const step = granularity === "hour" ? HOUR : DAY;
  const start = Math.floor(from / step) * step;
  const n = Math.max(1, Math.min(240, Math.ceil((to - start) / step)));
  const r = rng(seed);
  const raw = Array.from({ length: n }, (_, i) => Math.max(0, shape(i / n) * (0.6 + r() * 0.8)));
  const sum = raw.reduce((a, x) => a + x, 0) || 1;
  const series: BucketSeriesPoint[] = raw.map((x, i) => ({
    ts: iso(start + i * step),
    total_tokens: Math.round((x / sum) * b.total_tokens),
    events: Math.round((x / sum) * b.events),
    // 按与总量相同的比例摊开；桶成本为 null（整桶缺价）时每点也必须是 null
    cost_usd: b.cost_usd === null ? null : (x / sum) * b.cost_usd,
    unpriced_events: Math.round((x / sum) * b.unpriced_events),
  }));
  return { ...b, series };
}

function buildDistribution(p: DistributionParams): Distribution {
  const base = { profile_id: p.profile_id, by: p.by, from: p.from, to: p.to };
  const r = rng(5501 + p.by.length * 131);
  const from = Date.parse(p.from);
  const to = Date.parse(p.to);
  const granularity = p.bucket && p.bucket !== "none" ? p.bucket : null;

  switch (p.by) {
    case "machine": {
      // CONTRACT §2.1a：key = machine_id（与 /v1/timeline 同源），label = machine_label
      const buckets = MOCK_MACHINES.map((m, i) =>
        bucket(m.machine_id, 1800 - i * 340, Math.round((22 - i * 4.4) * 1e6), r, true, true, m.label),
      );
      return {
        ...base,
        buckets: granularity
          ? buckets.map((b, i) =>
              withSeries(b, from, to, granularity, 991 + i * 37, (k) =>
                Math.max(0, 0.45 + Math.sin(k * Math.PI * 2 - 1.2 + i * 0.7) * 0.55),
              ),
            )
          : buckets,
      };
    }

    case "model": {
      // 按区间长度缩放：真接口是按时间切的，mock 若对任何区间都返回同一份，
      // 「5h 窗口费用」和「7d 窗口费用」会显示成同一个数，把人误导到以为是 bug。
      const scale = Math.max(0.02, Math.min(6, (to - from) / DAY));
      // key = 模型名，label 缺省（前端自己去掉 claude- 前缀显示）
      const buckets = MODELS.map((m, i) =>
        bucket(
          m,
          Math.round(([4210, 2680, 1340, 451, 318][i] ?? 500) * scale),
          Math.round(([28_400_000, 17_900_000, 8_600_000, 3_100_000, 1_700_000][i] ?? 2e6) * scale),
          r,
          !UNPRICED_MODELS.has(m),
          true,
        ),
      );
      return {
        ...base,
        buckets: granularity
          ? buckets.map((b, i) =>
              withSeries(b, from, to, granularity, 3307 + i * 53, (k) =>
                Math.max(0, 0.4 + Math.sin(k * Math.PI * 2 - 0.6 + i * 0.9) * 0.6),
              ),
            )
          : buckets,
      };
    }

    case "project":
      return {
        ...base,
        // key = project_slug（可能已 HMAC 化），label = 可读别名
        buckets: PROJECTS.map((slug, i) =>
          bucket(
            slug,
            Math.round((14 - i) ** 1.9 * 6),
            Math.round((14 - i) ** 2.35 * (90_000 + r() * 60_000)),
            r,
            i !== 5, // ssh-* 那个桶缺价，保留「成本未知」分支
            true,
            // 最后一个桶刻意不给 label，走前端的 key 兜底显示
            i === PROJECTS.length - 1
              ? undefined
              : (slug.split("-").filter(Boolean).slice(-1)[0] ?? slug),
          ),
        ),
      };

    case "hour": {
      // key 是小时起点的 RFC3339 时刻（UTC）
      const hours = Math.max(1, Math.min(24 * 14, Math.round((to - from) / HOUR)));
      const start = Math.floor(to / HOUR) * HOUR - (hours - 1) * HOUR;
      const buckets: DistributionBucket[] = [];
      for (let i = 0; i < hours; i++) {
        const ms = start + i * HOUR;
        const d = new Date(ms);
        const workday = d.getDay() >= 1 && d.getDay() <= 5 ? 1 : 0.42;
        const h = d.getHours();
        const peak = Math.exp(-((h - 15) ** 2) / 26) + 0.55 * Math.exp(-((h - 10) ** 2) / 12);
        const tokens = Math.round(workday * peak * (900_000 + r() * 700_000));
        buckets.push(
          bucket(iso(ms), Math.max(1, Math.round(tokens / 34_000)), tokens, r, true, true),
        );
      }
      return { ...base, buckets };
    }

    case "attribution": {
      const rows: Array<[string, number, number]> = [
        ["proxy", 7412, 28_900_000],
        ["timeline", 2106, 9_400_000],
        ["fallback", 693, 4_800_000],
        ["unknown", 212, 2_100_000],
      ];
      return {
        ...base,
        buckets: rows.map(([k, ev, tk], i) => bucket(k, ev, tk, r, i < 3, true)),
      };
    }
  }
}

// ── /v1/quota/history ───────────────────────────────────────────────────────
/**
 * 历史额度快照。真接口来自 quota_snapshots，是**离散采样**（5 分钟一次），
 * 不是连续函数 —— mock 也按固定间隔出点，免得前端误以为可以随意插值。
 */
function buildQuotaHistory(p: QuotaHistoryParams): QuotaHistory {
  const from = Date.parse(p.from);
  const to = Date.parse(p.to);
  const step = 15 * 60_000;
  const n = Math.max(2, Math.min(700, Math.floor((to - from) / step)));
  const r = rng(7717 + p.window_kind.length);
  const samples: QuotaSample[] = [];
  let pct = 0;
  for (let i = 0; i < n; i++) {
    // 周窗口内百分比只增不减（窗口内不回落），重置由窗口边界本身表达
    pct = Math.min(100, pct + r() * (100 / n) * 1.6);
    samples.push({ ts: iso(from + i * step), utilization_pct: Math.round(pct * 10) / 10 });
  }
  return {
    profile_id: p.profile_id ?? "claude-official",
    window_kind: p.window_kind,
    from: iso(from),
    to: iso(to),
    samples,
  };
}

// ── /v1/calibration ─────────────────────────────────────────────────────────
function buildCalibration(profileId: string, nowMs: number): Calibration {
  const r = rng(9901);
  const limit = 5_810_000;
  const residual = 0.032;

  // delta_pct/100 = weighted_tokens / limit（ARCHITECTURE §7.0）
  const points: CalibrationPoint[] = Array.from({ length: 47 }, () => {
    const weighted = Math.round((0.03 + r() * 0.42) * limit);
    const fitted = (weighted / limit) * 100;
    const noise = (r() - 0.5) * 2 * residual * fitted;
    return {
      weighted_tokens: weighted,
      delta_pct: Math.round(Math.max(0, fitted + noise) * 100) / 100,
      fitted_pct: Math.round(fitted * 100) / 100,
    };
  }).sort((a, b) => a.weighted_tokens - b.weighted_tokens);

  const entry: CalibrationEntry = {
    window_kind: "five_hour",
    computed_at: iso(nowMs - 11 * MIN),
    limit_weighted_tokens: limit,
    base_model: "claude-fable-5",
    weights: {
      "claude-opus-5": 3.1,
      "claude-fable-5-1": 1.4,
      "claude-fable-5": 1.0,
      "claude-opus-4-8": 2.7,
    },
    residual,
    observations: points.length,
    converged: true,
    points,
  };

  // 七天窗口观测点不够 —— 契约说 calibrations 里干脆不出现这一项。
  return { profile_id: profileId, calibrations: [entry] };
}

// ── 数据源 ──────────────────────────────────────────────────────────────────
export function createMockApi(opts?: { latencyMs?: number }): UaApi {
  const latency = opts?.latencyMs ?? 180;
  const wait = <T>(v: T, signal?: AbortSignal): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = setTimeout(() => resolve(v), latency);
      signal?.addEventListener("abort", () => {
        clearTimeout(id);
        reject(new DOMException("aborted", "AbortError"));
      });
    });

  return {
    kind: "mock",
    profiles: (signal) => wait(MOCK_PROFILES, signal),
    machines: (signal) => wait(MOCK_MACHINES, signal),
    windowsCurrent: (_profileId, signal) => wait(windowsAt(Date.now(), 0), signal),
    timeline: (p, signal) => wait(buildTimeline(p, Date.now()), signal),
    distribution: (p, signal) => wait(buildDistribution(p), signal),
    calibration: (profileId, signal) => wait(buildCalibration(profileId, Date.now()), signal),
    quotaHistory: (p, signal) => wait(buildQuotaHistory(p), signal),
    stream(profileId, handlers) {
      handlers.onStatus("connecting");
      let drift = 0;
      let ticks = 0;
      const openId = setTimeout(() => handlers.onStatus("open"), 320);
      const tick = setInterval(() => {
        // 慢慢爬，让补间动画看得见，又不会几分钟就把窗口烧满
        drift = Math.min(9, drift + 0.15 + Math.random() * 0.3);
        handlers.onEvent({ type: "window_update", data: windowsAt(Date.now(), drift) });
        ticks += 1;
        if (ticks % 3 === 0) {
          const ev: StreamEvent = {
            type: "event_batch",
            data: {
              profile_id: profileId,
              count: 3 + Math.floor(Math.random() * 12),
              last_ts: iso(Date.now()),
            },
          };
          handlers.onEvent(ev);
        }
        if (ticks % 6 === 0) handlers.onEvent({ type: "ping", data: {} });
      }, 5000);
      return () => {
        clearTimeout(openId);
        clearInterval(tick);
        handlers.onStatus("closed");
      };
    },
  };
}
