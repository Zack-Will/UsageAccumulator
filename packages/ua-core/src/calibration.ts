/**
 * 把官方的百分比反解成绝对限额。见 ARCHITECTURE.md §7.0。
 *
 * 官方只给 utilization_pct，本地有精确 token。对每个采样区间：
 *     Δpct / 100 = ( Σ_m  w_m · tokens_m ) / L
 * 令 x_m = w_m / L，这就是一个非负最小二乘：min ‖A·x − b‖²  s.t. x ≥ 0。
 * 解出后固定某个基准模型 w_base = 1，即可同时得到 L 与各模型权重。
 */

export interface CalibObservation {
  /** 官方百分比增量，必须 > 0 */
  deltaPct: number;
  /** 该区间内各模型消耗的 token（已按 5m/1h 拆分后的加总由调用方决定口径） */
  tokensByModel: Record<string, number>;
  /** 是否单机独占区间。多机并发时本地可能收不全，会污染回归 */
  singleMachine: boolean;
}

export interface CalibrationResult {
  /** 反解出的限额绝对值（加权 token / 窗口） */
  limitWeightedTokens: number;
  /** 各模型权重，基准模型为 1 */
  weights: Record<string, number>;
  baseModel: string;
  /** 相对残差 ‖Ax−b‖/‖b‖ */
  residual: number;
  observations: number;
  converged: boolean;
}

export interface CalibrateOptions {
  /** 权重基准模型；缺省取 token 总量最大的那个 */
  baseModel?: string;
  /** 少于这个数量不出结果，看板显示「标定中」 */
  minObservations?: number;
  maxIter?: number;
  tol?: number;
}

/** 非负最小二乘：投影梯度下降。规模极小（模型数 × 观测数），够用。 */
function nnls(A: number[][], b: number[], maxIter: number, tol: number): { x: number[]; converged: boolean } {
  const m = A.length;
  const n = m > 0 ? (A[0]?.length ?? 0) : 0;
  const x = new Array<number>(n).fill(0);
  if (m === 0 || n === 0) return { x, converged: false };

  // 幂迭代估 A^T A 的最大特征值，用作步长的倒数
  let v = new Array<number>(n).fill(1 / Math.sqrt(n));
  let lip = 1;
  for (let it = 0; it < 50; it++) {
    const Av = new Array<number>(m).fill(0);
    for (let i = 0; i < m; i++) {
      const row = A[i]!;
      let s = 0;
      for (let j = 0; j < n; j++) s += (row[j] ?? 0) * (v[j] ?? 0);
      Av[i] = s;
    }
    const AtAv = new Array<number>(n).fill(0);
    for (let i = 0; i < m; i++) {
      const row = A[i]!;
      const a = Av[i] ?? 0;
      for (let j = 0; j < n; j++) AtAv[j] = (AtAv[j] ?? 0) + (row[j] ?? 0) * a;
    }
    const norm = Math.sqrt(AtAv.reduce((s, t) => s + t * t, 0));
    if (norm === 0) break;
    lip = norm;
    v = AtAv.map((t) => t / norm);
  }
  const step = 1 / Math.max(lip, 1e-12);

  let converged = false;
  for (let it = 0; it < maxIter; it++) {
    // grad = A^T (A x - b)
    const r = new Array<number>(m).fill(0);
    for (let i = 0; i < m; i++) {
      const row = A[i]!;
      let s = 0;
      for (let j = 0; j < n; j++) s += (row[j] ?? 0) * (x[j] ?? 0);
      r[i] = s - (b[i] ?? 0);
    }
    const g = new Array<number>(n).fill(0);
    for (let i = 0; i < m; i++) {
      const row = A[i]!;
      const ri = r[i] ?? 0;
      for (let j = 0; j < n; j++) g[j] = (g[j] ?? 0) + (row[j] ?? 0) * ri;
    }
    let maxDelta = 0;
    for (let j = 0; j < n; j++) {
      const next = Math.max(0, (x[j] ?? 0) - step * (g[j] ?? 0));
      maxDelta = Math.max(maxDelta, Math.abs(next - (x[j] ?? 0)));
      x[j] = next;
    }
    if (maxDelta < tol) {
      converged = true;
      break;
    }
  }
  return { x, converged };
}

export function calibrate(
  observations: CalibObservation[],
  opts: CalibrateOptions = {},
): CalibrationResult | null {
  const minObs = opts.minObservations ?? 30;

  // 只用干净观测：单机独占、百分比确实前进过
  const clean = observations.filter(
    (o) => o.singleMachine && Number.isFinite(o.deltaPct) && o.deltaPct > 0,
  );
  if (clean.length < minObs) return null;

  const models = [...new Set(clean.flatMap((o) => Object.keys(o.tokensByModel)))].sort();
  if (models.length === 0) return null;

  const A = clean.map((o) => models.map((mo) => o.tokensByModel[mo] ?? 0));
  const b = clean.map((o) => o.deltaPct / 100);

  const { x, converged } = nnls(A, b, opts.maxIter ?? 20000, opts.tol ?? 1e-14);

  // 基准模型：token 总量最大的那个，且其 x 必须为正
  const totals = new Map<string, number>();
  for (const o of clean) {
    for (const [mo, t] of Object.entries(o.tokensByModel)) {
      totals.set(mo, (totals.get(mo) ?? 0) + t);
    }
  }
  const ranked = models
    .map((mo, j) => ({ mo, j, x: x[j] ?? 0, tot: totals.get(mo) ?? 0 }))
    .filter((r) => r.x > 0)
    .sort((p, q) => q.tot - p.tot);
  const base = opts.baseModel
    ? ranked.find((r) => r.mo === opts.baseModel) ?? ranked[0]
    : ranked[0];
  if (!base || base.x <= 0) return null;

  const limit = 1 / base.x;
  const weights: Record<string, number> = {};
  models.forEach((mo, j) => {
    weights[mo] = (x[j] ?? 0) * limit;
  });

  // 相对残差
  let num = 0;
  let den = 0;
  for (let i = 0; i < A.length; i++) {
    const row = A[i]!;
    let s = 0;
    for (let j = 0; j < row.length; j++) s += (row[j] ?? 0) * (x[j] ?? 0);
    const d = s - (b[i] ?? 0);
    num += d * d;
    den += (b[i] ?? 0) ** 2;
  }
  const residual = den > 0 ? Math.sqrt(num / den) : 0;

  return {
    limitWeightedTokens: limit,
    weights,
    baseModel: base.mo,
    residual,
    observations: clean.length,
    converged,
  };
}
