import type { ThemeName } from "@ua/tokens";
import type { DataSource, Profile, StreamStatus } from "../api";
import { fmtClock } from "../charts/base";
import { hrefFor, ROUTES, type RouteId } from "../hooks/useRoute";
import { Dot, Segmented } from "./primitives";

export const RANGES = [
  { value: "5h", label: "5h", ms: 5 * 3600_000 },
  { value: "24h", label: "24h", ms: 24 * 3600_000 },
  { value: "7d", label: "7d", ms: 7 * 24 * 3600_000 },
  { value: "30d", label: "30d", ms: 30 * 24 * 3600_000 },
] as const;

export type RangeId = (typeof RANGES)[number]["value"];

const ROUTE_LABEL: Record<RouteId, string> = {
  overview: "总览",
  weeks: "周历史",
  windows: "窗口分析",
  distribution: "用量分布",
};

const STATUS_TONE: Record<StreamStatus, "ok" | "warn" | "danger"> = {
  open: "ok",
  connecting: "warn",
  closed: "danger",
};

const STATUS_TEXT: Record<StreamStatus, string> = {
  open: "已连接",
  connecting: "连接中",
  closed: "已断开",
};

/** CONTRACT §2.1：stale = 超过 15 分钟没有新快照；captured_at 是快照采集时刻，不是请求时刻。 */
function syncTone(s: StreamStatus, stale: boolean): "ok" | "warn" | "danger" {
  if (s === "closed") return "danger";
  return stale ? "warn" : STATUS_TONE[s];
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" strokeLinecap="round" />
      <path d="M13.6 2.2v2.9h-2.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ThemeIcon({ theme }: { theme: ThemeName }) {
  return theme === "dark" ? (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8 5.6 5.6 0 1 0 13.2 9.6Z" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="8" cy="8" r="3.1" />
      <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9 13 13M13 3l-1.1 1.1M4.1 11.9 3 13" strokeLinecap="round" />
    </svg>
  );
}

export function TopBar(props: {
  route: RouteId;
  profiles: Profile[];
  profileId: string;
  onProfile: (id: string) => void;
  range: RangeId;
  onRange: (r: RangeId) => void;
  theme: ThemeName;
  onTheme: (t: ThemeName) => void;
  source: DataSource;
  onSource: (s: DataSource) => void;
  streamStatus: StreamStatus;
  /** 最近一次额度快照的采集时刻（CONTRACT §2.1 captured_at）。 */
  capturedAt: number | null;
  stale: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <header className="topbar">
      <span className="brand">UsageAccumulator</span>

      <nav className="nav" aria-label="页面">
        {ROUTES.map((r) => (
          <a
            key={r}
            className="nav__link"
            href={hrefFor(r)}
            aria-current={r === props.route ? "page" : undefined}
          >
            {ROUTE_LABEL[r]}
          </a>
        ))}
      </nav>

      <span className="topbar__spacer" />

      <label className="visually-hidden" htmlFor="profile-select">
        Profile
      </label>
      <select
        id="profile-select"
        className="select"
        value={props.profileId}
        onChange={(e) => props.onProfile(e.target.value)}
      >
        {props.profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>

      <Segmented
        label="时间范围"
        value={props.range}
        options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
        onChange={props.onRange}
      />

      <Segmented
        label="数据源"
        value={props.source}
        options={[
          { value: "mock", label: "mock" },
          { value: "live", label: "live" },
        ]}
        onChange={props.onSource}
      />

      <span
        className="sync"
        aria-label={`同步状态：${STATUS_TEXT[props.streamStatus]}${props.stale ? "，快照已过期" : ""}`}
      >
        <Dot tone={syncTone(props.streamStatus, props.stale)} />
        {/* 这个钟点是**额度快照**的采集时刻，不是现在几点 —— 不写明就会被当成时钟。
            窄屏放不下文字时只留钟点（不能为了四个字把整条顶栏挤成两行），悬停仍可见 */}
        <span className="sync__label">额度更新</span>
        <span title="额度更新时刻">{props.capturedAt ? fmtClock(props.capturedAt) : "--:--"}</span>
      </span>

      <button
        type="button"
        className={`iconbtn${props.refreshing ? " iconbtn--spin" : ""}`}
        aria-label="刷新"
        onClick={props.onRefresh}
      >
        <RefreshIcon />
      </button>

      <button
        type="button"
        className="iconbtn"
        aria-label={props.theme === "dark" ? "切换到日间主题" : "切换到暗色主题"}
        onClick={() => props.onTheme(props.theme === "dark" ? "light" : "dark")}
      >
        <ThemeIcon theme={props.theme} />
      </button>
    </header>
  );
}
