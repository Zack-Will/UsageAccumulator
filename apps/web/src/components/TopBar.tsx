import type { ThemeName } from "@ua/tokens";
import type { CodexSessionStatus, Profile, QuotaSessionStatus, StreamStatus } from "../api";
import type { Provider } from "../hooks/useProvider";
import { codexSessionBadge, codexSessionTone } from "./CodexSession";
import { ClaudeIcon, OpenAIIcon } from "./ProviderIcons";
import { appBridge } from "../app-bridge";
import { fmtClock } from "../charts/base";
import { hrefFor, ROUTES, type RouteId } from "../hooks/useRoute";
import { Dot, Segmented } from "./primitives";
import { planLabel, sessionBadge, sessionTone } from "./QuotaSession";

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

/** Codex 没有标定、也没有多机重叠的甘特：窗口分析只属于 Claude */
export const routesFor = (provider: Provider): readonly RouteId[] =>
  provider === "codex" ? ROUTES.filter((r) => r !== "windows") : ROUTES;

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
function syncTone(s: StreamStatus, stale: boolean, session: QuotaSessionStatus | null): "ok" | "warn" | "danger" {
  if (s === "closed") return "danger";
  // 服务端抓额度的会话出了问题，比「快照有点旧」更要紧，优先显示
  const bySession = sessionTone(session?.state);
  if (bySession) return bySession;
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

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7" strokeLinecap="round" />
      <circle cx="11" cy="4.5" r="1.5" />
      <circle cx="5" cy="11.5" r="1.5" />
    </svg>
  );
}

export function TopBar(props: {
  route: RouteId;
  provider: Provider;
  onProvider: (p: Provider) => void;
  /** Codex 下顶栏的同步按钮改说 Codex：额度快照时刻 + 服务端那份登录的状态 */
  codex: { session: CodexSessionStatus | null; capturedAt: number | null; stale: boolean; onSession: () => void };
  profiles: Profile[];
  profileId: string;
  onProfile: (id: string) => void;
  range: RangeId;
  onRange: (r: RangeId) => void;
  theme: ThemeName;
  onTheme: (t: ThemeName) => void;
  streamStatus: StreamStatus;
  /** 最近一次额度快照的采集时刻（CONTRACT §2.1 captured_at）。 */
  capturedAt: number | null;
  stale: boolean;
  /** 服务端抓额度用的 claude.ai 会话状态；null = 还没问到 */
  quotaSession: QuotaSessionStatus | null;
  onQuotaSession: () => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const bridge = appBridge();
  const codex = props.provider === "codex";
  const codexTone = codexSessionTone(props.codex.session?.state);
  const codexAlert = codexTone === "danger" || codexTone === "warn";
  return (
    <header className="topbar">
      <span className="brand">UsageAccumulator</span>

      <nav className="nav" aria-label="页面">
        {routesFor(props.provider).map((r) => (
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

      <div className="seg seg--provider" role="group" aria-label="服务">
        <button type="button" className="seg__btn" aria-pressed={!codex} aria-label="Claude" title="Claude" onClick={() => props.onProvider("claude")}>
          <ClaudeIcon />
        </button>
        <button type="button" className="seg__btn" aria-pressed={codex} aria-label="Codex" title="Codex" onClick={() => props.onProvider("codex")}>
          <OpenAIIcon />
        </button>
      </div>

      {/* Codex 是独立账本，不挂在 Claude 的 profile 下：选 Codex 时没有可选的 profile */}
      {!codex && (
        <>
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
                {planLabel(p.plan) ?? p.label}
              </option>
            ))}
          </select>
        </>
      )}

      <Segmented
        label="时间范围"
        value={props.range}
        options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
        onChange={props.onRange}
      />

      {/* 点开是服务端抓额度用的那份登录（Claude：claude.ai 会话；Codex：服务端专用的 ChatGPT 登录）——
          同步状态出问题时，要做的动作多半就在这里 */}
      {codex ? (
        <button
          type="button"
          className={`sync${codexAlert ? " sync--alert" : ""}`}
          onClick={props.codex.onSession}
          aria-haspopup="dialog"
          aria-label={`Codex 同步状态：${codexSessionBadge(props.codex.session?.state)}${props.codex.stale ? "，快照已过期" : ""}`}
        >
          <Dot tone={codexTone === "muted" ? (props.codex.stale ? "warn" : "ok") : codexTone === "ok" && props.codex.stale ? "warn" : codexTone} />
          <span className="sync__label">{codexSessionBadge(props.codex.session?.state)}</span>
          <span title="额度更新时刻">{props.codex.capturedAt ? fmtClock(props.codex.capturedAt) : "--:--"}</span>
        </button>
      ) : (
      <button
        type="button"
        className={`sync${sessionTone(props.quotaSession?.state) ? " sync--alert" : ""}`}
        onClick={props.onQuotaSession}
        aria-haspopup="dialog"
        aria-label={`同步状态：${STATUS_TEXT[props.streamStatus]}${props.stale ? "，快照已过期" : ""}，${sessionBadge(props.quotaSession?.state)}`}
      >
        <Dot tone={syncTone(props.streamStatus, props.stale, props.quotaSession)} />
        {/* 这个钟点是**额度快照**的采集时刻，不是现在几点 —— 不写明就会被当成时钟。
            窄屏放不下文字时只留钟点（不能为了四个字把整条顶栏挤成两行），悬停仍可见 */}
        <span className="sync__label">{sessionBadge(props.quotaSession?.state)}</span>
        <span title="额度更新时刻">{props.capturedAt ? fmtClock(props.capturedAt) : "--:--"}</span>
      </button>
      )}

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

      {/* 只在安卓外壳里出现：服务器地址、小部件这些是外壳的设置，网页管不着 */}
      {bridge && (
        <button type="button" className="iconbtn" aria-label="App 设置" onClick={() => bridge.openSettings()}>
          <SettingsIcon />
        </button>
      )}
    </header>
  );
}
