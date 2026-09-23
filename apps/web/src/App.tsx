import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createApi,
  fetchSessionStatus,
  readToken,
  persistDataSource,
  resolveDataSource,
  type DataSource,
  type StreamStatus,
  type WindowsCurrent,
} from "./api";
import { RANGES, TopBar, type RangeId } from "./components/TopBar";
import { QuotaSessionDialog } from "./components/QuotaSession";
import { useAsync } from "./hooks/useAsync";
import { useRoute } from "./hooks/useRoute";
import { useTheme } from "./hooks/useTheme";
import { useTokens } from "./hooks/useTokens";
import { Distribution } from "./pages/Distribution";
import { Overview } from "./pages/Overview";
import { Weeks } from "./pages/Weeks";
import { Windows } from "./pages/Windows";

/** 走动的“现在”，用于 ETA 倒计时与燃尽曲线游标。 */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

import { LoginGate } from "./components/LoginGate";

export function App() {
  const [theme, setTheme] = useTheme();
  const tokens = useTokens(theme);
  const route = useRoute();
  const nowMs = useNow(10_000);

  const [source, setSource] = useState<DataSource>(resolveDataSource);
  const [token, setToken] = useState(readToken);
  /**
   * 门口的状态。null = 还没问出结果，先什么都别画 ——
   * 先渲染看板再弹登录框会让人看见一屏 401 的空壳。
   */
  const [gate, setGate] = useState<{ authed: boolean; passwordLogin: boolean } | null>(null);
  const [authNonce, setAuthNonce] = useState(0);
  const [profileId, setProfileId] = useState("claude-official");
  const [range, setRange] = useState<RangeId>("24h");
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const api = useMemo(() => createApi(source), [source, token]);

  /**
   * 只在生产构建的 live 模式下探会话：开发时 Vite 代理会在代理层注入 Authorization，
   * 客户端本来就不需要凭证，再挡一道只会碍事。
   */
  const needGate = import.meta.env.PROD && source === "live";
  useEffect(() => {
    if (!needGate) {
      setGate({ authed: true, passwordLogin: false });
      return;
    }
    let alive = true;
    setGate(null);
    void fetchSessionStatus()
      .then((s) => {
        if (!alive) return;
        // 已有可用 token 的老用户直接放行，不必为了这次改动重新登一遍
        setGate({ authed: s.authenticated || readToken() !== "", passwordLogin: s.password_login });
      })
      .catch(() => {
        if (alive) setGate({ authed: readToken() !== "", passwordLogin: false });
      });
    return () => {
      alive = false;
    };
  }, [needGate, authNonce]);

  const onSource = useCallback((s: DataSource) => {
    persistDataSource(s);
    setSource(s);
  }, []);

  const onRefresh = useCallback(() => {
    setNonce((n) => n + 1);
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 650);
  }, []);

  // 时间范围 → from/to（CONTRACT §4：UTC，RFC3339，带 Z）
  const { from, to } = useMemo(() => {
    const spanMs = RANGES.find((r) => r.value === range)?.ms ?? 24 * 3600_000;
    const end = Date.now();
    return { from: new Date(end - spanMs).toISOString(), to: new Date(end).toISOString() };
  }, [range, nonce]);

  const profiles = useAsync((s) => api.profiles(s), [api, nonce]);
  // 机器名册：把 /v1/timeline 的 machine_id 与 /v1/distribution 的 bucket key
  // 归一到同一个规范 id，机器色才能跨图一致。
  const machines = useAsync((s) => api.machines(s), [api, nonce]);

  // 首屏拉一次 /v1/windows/current，之后靠 SSE 增量推送，不轮询。
  const initialWindows = useAsync((s) => api.windowsCurrent(profileId, s), [api, profileId, nonce]);
  const [pushed, setPushed] = useState<WindowsCurrent | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");

  useEffect(() => {
    setPushed(null);
    const stop = api.stream(profileId, {
      onEvent: (e) => {
        if (e.type === "window_update") setPushed(e.data);
      },
      onStatus: setStreamStatus,
    });
    return stop;
  }, [api, profileId]);

  const windows = pushed ?? initialWindows.data;

  // 服务端抓额度的会话状态。失效是服务端几分钟一轮的采样才发现的，这里每分钟问一次就够
  const [sessionTick, setSessionTick] = useState(0);
  const [sessionOpen, setSessionOpen] = useState(false);
  const quotaSession = useAsync((s) => api.quotaSession(profileId, s), [api, profileId, nonce, sessionTick]);
  useEffect(() => {
    const id = setInterval(() => setSessionTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // 同步状态取额度快照的时刻，不是本次请求时刻（CONTRACT §2.2 的说明同样适用于看板）
  const head = windows?.windows[0];
  const capturedAt = head ? Date.parse(head.captured_at) : null;
  const stale = windows?.windows.some((w) => w.stale) ?? false;

  const profileList = profiles.data ?? [];
  useEffect(() => {
    if (profileList.length > 0 && !profileList.some((p) => p.id === profileId)) {
      const first = profileList[0];
      if (first) setProfileId(first.id);
    }
  }, [profileList, profileId]);

  if (gate === null) return <div className="gate" />;
  if (!gate.authed) {
    return (
      <LoginGate
        passwordLogin={gate.passwordLogin}
        onSuccess={() => {
          setToken(readToken());
          setAuthNonce((n) => n + 1);
        }}
      />
    );
  }

  return (
    <div className="shell">
      <TopBar
        route={route}
        profiles={profileList}
        profileId={profileId}
        onProfile={setProfileId}
        range={range}
        onRange={setRange}
        theme={theme}
        onTheme={setTheme}
        source={source}
        onSource={onSource}
        streamStatus={streamStatus}
        capturedAt={capturedAt}
        stale={stale}
        quotaSession={quotaSession.data}
        onQuotaSession={() => setSessionOpen(true)}
        refreshing={refreshing}
        onRefresh={onRefresh}
      />

      {sessionOpen && (
        <QuotaSessionDialog
          api={api}
          profileId={profileId}
          status={quotaSession.data}
          onClose={() => setSessionOpen(false)}
          onChanged={() => setSessionTick((n) => n + 1)}
        />
      )}

      <main className="main">
        {route === "overview" && (
          <Overview
            api={api}
            t={tokens}
            profileId={profileId}
            from={from}
            to={to}
            rangeLabel={RANGES.find((r) => r.value === range)?.label ?? range}
            nonce={nonce}
            nowMs={nowMs}
            machines={machines.data ?? []}
            windows={windows}
            windowsError={initialWindows.error}
          />
        )}
        {route === "weeks" && (
          <Weeks api={api} t={tokens} profileId={profileId} nonce={nonce} windows={windows} />
        )}
        {route === "windows" && (
          <Windows
            api={api}
            t={tokens}
            profileId={profileId}
            from={from}
            to={to}
            nonce={nonce}
            nowMs={nowMs}
            windows={windows}
            windowsError={initialWindows.error}
          />
        )}
        {route === "distribution" && (
          <Distribution api={api} t={tokens} profileId={profileId} from={from} to={to} nonce={nonce} />
        )}
      </main>
    </div>
  );
}
