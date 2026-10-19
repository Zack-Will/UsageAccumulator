import { useEffect, useRef, useState } from "react";
import type { CodexSessionState, CodexSessionStatus, UaApi } from "../api";
import { fmtWhen } from "../charts/base";
import { Dot } from "./primitives";
import { planLabel } from "./QuotaSession";

/**
 * 服务端抓 Codex 额度用的那份 ChatGPT 登录（docs/CODEX-API.md「Server-side quota collection」）。
 *
 * ★ 必须是**专门为服务端另登的一份**：refresh token 一次性，和本机 Codex CLI 共用会互相踢下线。
 *   框只写不读，保存后任何接口都不回显。
 */
export function codexSessionTone(state: CodexSessionState | undefined): "ok" | "warn" | "danger" | "muted" {
  if (state === "ok") return "ok";
  if (state === "auth" || state === "blocked" || state === "account") return "danger";
  if (state === "none" || state === "error") return "warn";
  return "muted";
}

export function codexSessionLine(s: CodexSessionStatus | null, nowMs: number): string {
  if (!s) return "—";
  const when = (v: string | null) => (v ? fmtWhen(Date.parse(v), nowMs) : "");
  switch (s.state) {
    case "ok":
      return `正常 · ${when(s.last_ok_at)}`;
    case "pending":
      return "等待采集";
    case "auth":
      return s.last_ok_at ? `登录失效 · 最后正常 ${when(s.last_ok_at)}` : "登录失效";
    case "blocked":
      return "被 Cloudflare 拦截";
    case "account":
      return s.error ?? "账号不符";
    case "error":
      return s.next_attempt_at ? `暂时失败 · ${when(s.next_attempt_at)} 重试` : "暂时失败";
    case "none":
      return "未登录";
    case "disabled":
      return "服务端未开启采集";
  }
}

export function CodexSessionDialog({
  api,
  status,
  onClose,
  onChanged,
}: {
  api: UaApi;
  status: CodexSessionStatus | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [shown, setShown] = useState<CodexSessionStatus | null>(status);
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
      const next = await api.saveCodexSession(trimmed);
      setValue("");
      onChanged();
      if (next.state === "ok") onClose();
      else setShown(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!confirmClear) {
      setConfirmClear(true);
      confirmTimer.current = setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setShown(await api.clearCodexSession());
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
      setConfirmClear(false);
    }
  }

  const editable = shown?.state !== "disabled";
  const who = [shown?.email, planLabel(shown?.plan_type ?? null)].filter(Boolean).join(" · ");
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form className="gate-card dialog" role="dialog" aria-modal="true" aria-labelledby="cs-title" onSubmit={submit}>
        <h2 id="cs-title" className="gate-title">
          Codex 登录
        </h2>
        <p className="dialog__status" title={shown?.error ?? undefined}>
          <Dot tone={codexSessionTone(shown?.state)} />
          {codexSessionLine(shown, Date.now())}
        </p>
        {who && <p className="dialog__status">{who}</p>}
        {editable && (
          <>
            <label className="gate-label" htmlFor="cs-cred">
              服务端专用登录的 auth.json
            </label>
            <textarea
              id="cs-cred"
              className="gate-input"
              name="codex-credential"
              autoComplete="off"
              spellCheck={false}
              rows={4}
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
          {editable && shown && shown.state !== "none" ? (
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
