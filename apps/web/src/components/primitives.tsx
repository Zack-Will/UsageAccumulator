import type { ReactNode } from "react";
import { useTween } from "../hooks/useTween";

// ── 面板 ────────────────────────────────────────────────────────────────────
export function Card({
  title,
  aside,
  tone = "plain",
  span,
  mdSpan,
  children,
}: {
  title?: string;
  aside?: ReactNode;
  tone?: "plain" | "warn" | "danger";
  span?: number;
  /**
   * 中等宽度（≤1080px，6 栅格）下占几列；缺省占满一行。
   * 以前这个断点下所有卡一律整行 —— 三张额度卡被拆成三行，一屏只剩额度。
   */
  mdSpan?: number;
  children: ReactNode;
}) {
  const style: Record<string, string> = {};
  if (span) style["gridColumn"] = `span ${span}`;
  if (mdSpan) style["--md-span"] = String(mdSpan);
  return (
    <section
      className={`card card--${tone}`}
      style={Object.keys(style).length ? (style as React.CSSProperties) : undefined}
      aria-label={title}
    >
      {(title || aside) && (
        <header className="card__head">
          {title && <h2 className="card__title">{title}</h2>}
          {aside && <div className="card__aside">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

// ── 补间数字 ────────────────────────────────────────────────────────────────
export function Num({
  value,
  digits = 0,
  suffix,
  size = "md",
  tone,
  animate = true,
}: {
  value: number;
  digits?: number;
  suffix?: string;
  size?: "sm" | "md" | "lg" | "xl";
  tone?: "ok" | "warn" | "danger" | "muted";
  animate?: boolean;
}) {
  const tweened = useTween(animate ? value : 0, 300);
  const shown = animate ? tweened : value;
  return (
    <span className={`num num--${size}${tone ? ` num--${tone}` : ""}`}>
      {Number.isFinite(shown) ? shown.toFixed(digits) : "—"}
      {suffix && <span className="num__suffix">{suffix}</span>}
    </span>
  );
}

/** 不参与补间的等宽文本（时间、比值等）。 */
export function Mono({ children, tone }: { children: ReactNode; tone?: "muted" | "warn" | "danger" }) {
  return <span className={`mono${tone ? ` mono--${tone}` : ""}`}>{children}</span>;
}

/**
 * 成本。CONTRACT §2.1a：cost_usd = null 表示「该桶无任何有报价的模型」，
 * unpriced_events > 0 表示「成本不完整」。两者都不能显示成 $0.00 —— 定价表是
 * 刻意留空的，把缺价渲染成 0 会让成本统计静默出错。
 */
export function Cost({ usd, unpriced }: { usd: number | null; unpriced: number }) {
  if (usd === null) {
    return (
      <span className="cost" aria-label={`成本未知，${unpriced} 个事件缺少报价`}>
        <span className="mono mono--muted">—</span>
        <span className="cost__mark" aria-hidden="true">
          †
        </span>
      </span>
    );
  }
  return (
    <span
      className="cost"
      aria-label={unpriced > 0 ? `${usd.toFixed(4)} 美元，另有 ${unpriced} 个事件缺少报价` : undefined}
    >
      <span className="mono">${usd.toFixed(2)}</span>
      {unpriced > 0 && (
        <span className="cost__mark" aria-hidden="true">
          †
        </span>
      )}
    </span>
  );
}

// ── 分段控件 ────────────────────────────────────────────────────────────────
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="seg__btn"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── 状态 / 占位 ─────────────────────────────────────────────────────────────
export function Dot({ tone }: { tone: "ok" | "warn" | "danger" | "muted" }) {
  return <span className={`dot dot--${tone}`} aria-hidden="true" />;
}

export function Placeholder({ state, height = 120 }: { state: "loading" | "error"; height?: number }) {
  return (
    <div className="ph" style={{ height }} role="status">
      <span className={`ph__bar${state === "error" ? " ph__bar--error" : ""}`} />
    </div>
  );
}

export function KeyValue({ items }: { items: ReadonlyArray<{ k: string; v: ReactNode }> }) {
  return (
    <dl className="kv">
      {items.map((it) => (
        <div key={it.k} className="kv__row">
          <dt>{it.k}</dt>
          <dd>{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}
