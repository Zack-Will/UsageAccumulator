import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createApi,
  readToken,
  persistDataSource,
  resolveDataSource,
  type DataSource,
  type StreamStatus,
  type WindowsCurrent,
} from "./api";
import { RANGES, TopBar, type RangeId } from "./components/TopBar";
import { useAsync } from "./hooks/useAsync";
import { useRoute } from "./hooks/useRoute";
import { useTheme } from "./hooks/useTheme";
import { useTokens } from "./hooks/useTokens";
import { Distribution } from "./pages/Distribution";
import { Overview } from "./pages/Overview";
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

import { TokenGate } from "./components/TokenGate";

export function App() {
  const [theme, setTheme] = useTheme();
  const tokens = useTokens(theme);
  const route = useRoute();
  const nowMs = useNow(10_000);

  const [source, setSource] = useState<DataSource>(resolveDataSource);
  const [token, setToken] = useState(readToken);
  const [profileId, setProfileId] = useState("claude-official");
  const [range, setRange] = useState<RangeId>("24h");
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const api = useMemo(() => createApi(source), [source, token]);

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

  // 只在生产构建里挡：开发时 Vite 代理会在代理层注入 Authorization，
  // 客户端本来就不需要 token，再弹输入框只会挡住开发流程。
  if (import.meta.env.PROD && source === "live" && !token) {
    return <TokenGate onSaved={() => setToken(readToken())} />;
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
        refreshing={refreshing}
        onRefresh={onRefresh}
      />

      <main className="main">
        {route === "overview" && (
          <Overview
            api={api}
            t={tokens}
            profileId={profileId}
            from={from}
            to={to}
            nonce={nonce}
            nowMs={nowMs}
            machines={machines.data ?? []}
            windows={windows}
            windowsError={initialWindows.error}
          />
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
