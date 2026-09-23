import { useEffect, useRef, useState } from "react";
import type { QuotaSessionState, QuotaSessionStatus, UaApi } from "../api";
import { fmtWhen } from "../charts/base";
import { Dot } from "./primitives";

/**
 * claude.ai 会话：服务端直接抓额度要用（ARCHITECTURE §5.3）。
 *
 * 服务端没有浏览器，没法替你走 claude.ai 的邮件 / Google 登录（那条路要过人机验证，不做）；
 * 所以这里的「登录」就是把浏览器里的 sessionKey 交给服务端 —— 服务端先拿去问 claude.ai，
 * 认了才保存。保存之后任何接口都不回显它，这个框也只写不读。
 */

/** 顶栏上那颗点的颜色：会话出问题比「快照有点旧」更要紧。 */
export function sessionTone(state: QuotaSessionState | undefined): "danger" | "warn" | null {
  if (state === "auth" || state === "blocked") return "danger";
  if (state === "none" || state === "error") return "warn";
  return null;
}

/** 顶栏上的四个字：出问题时直接说是什么问题，正常时照旧是「额度更新」。 */
export function sessionBadge(state: QuotaSessionState | undefined): string {
  if (state === "auth") return "会话失效";
  if (state === "blocked") return "被拦截";
  if (state === "none") return "未登录";
  return "额度更新";
}

function statusLine(s: QuotaSessionStatus | null, nowMs: number): string {
  if (!s) return "—";
  const when = (v: string | null) => (v ? fmtWhen(Date.parse(v), nowMs) : "");
  switch (s.state) {
    case "ok":
      return `正常 · ${when(s.last_ok_at)}`;
    case "pending":
      return "等待采集";
    case "auth":
      return s.last_ok_at ? `会话失效 · 最后正常 ${when(s.last_ok_at)}` : "会话失效";
    case "blocked":
      return "被 Cloudflare 拦截";
    case "error":
      return s.next_attempt_at ? `暂时失败 · ${when(s.next_attempt_at)} 重试` : "暂时失败";
    case "none":
      return "未登录";
    case "disabled":
      return "服务端未开启采集";
  }
}

function lineTone(state: QuotaSessionState | undefined): "ok" | "warn" | "danger" | "muted" {
  if (state === "ok") return "ok";
  return sessionTone(state) ?? "muted";
}

export function QuotaSessionDialog({
  api,
  profileId,
  status,
  onClose,
  onChanged,
}: {
  api: UaApi;
  profileId: string;
  status: QuotaSessionStatus | null;
  onClose: () => void;
  /** 保存或退出之后调用，让上层重新拉状态 */
  onChanged: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [shown, setShown] = useState<QuotaSessionStatus | null>(status);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trimmed = value.trim();

  useEffect(() => setShown(status), [status]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    globalThis.addEventListener("keydown", onKey);
    return () => {
      globalThis.removeEventListener("keydown", onKey);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.saveQuotaSession(profileId, trimmed);
      setValue("");
      onChanged();
      // 抓到了就收起；存上了但第一次没抓成功，留着让人看见是什么状态
      if (next.state === "ok") onClose();
      else setShown(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    // 退出之后要重新拿 sessionKey 才能恢复采集，所以要按第二下才生效
    if (!confirmClear) {
      setConfirmClear(true);
      confirmTimer.current = setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setShown(await api.clearQuotaSession(profileId));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
      setConfirmClear(false);
    }
  }

  const state = shown?.state;
  const editable = state !== "disabled";
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="gate-card dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="qs-title"
        onSubmit={submit}
      >
        <h2 id="qs-title" className="gate-title">
          claude.ai 会话
        </h2>
        <p className="dialog__status" title={shown?.error ?? undefined}>
          <Dot tone={lineTone(state)} />
          {statusLine(shown, Date.now())}
        </p>
        {editable && (
          <>
            <label className="gate-label" htmlFor="qs-key">
              sessionKey
            </label>
            <input
              id="qs-key"
              className="gate-input"
              type="password"
              name="session-key"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
            />
            <button className="gate-submit" type="submit" disabled={!trimmed || busy}>
              {busy ? "验证中…" : "保存"}
            </button>
          </>
        )}
        {error && <p className="gate-error">{error}</p>}
        <div className="dialog__actions">
          {editable && state !== "none" && state !== undefined ? (
            <button className="gate-alt" type="button" onClick={() => void clear()} disabled={busy}>
              {confirmClear ? "再按一次退出" : "退出登录"}
            </button>
          ) : (
            <span />
          )}
          <button className="gate-alt" type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </form>
    </div>
  );
}
