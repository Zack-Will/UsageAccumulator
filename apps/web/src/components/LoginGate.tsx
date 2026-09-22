import { useState } from "react";
import { login, persistToken } from "../api";

/**
 * live 模式下没有凭证时挡在前面的门。
 *
 * 之所以需要它：看板由服务端在公网托管，凭证不能打进 JS 产物（谁都能读），
 * 只能由使用者在自己浏览器里给一次。
 *
 * 两种给法：
 *   · 密码 → 服务端换一张 HttpOnly 会话 Cookie（默认，记得住，换设备不用翻 .env）
 *   · token → 存 localStorage（服务端没配密码时的退路，也留给脚本口径一致）
 */
export function LoginGate({
  passwordLogin,
  onSuccess,
}: {
  /** 服务端是否配了 UA_DASHBOARD_PASSWORD */
  passwordLogin: boolean;
  onSuccess: () => void;
}) {
  // 服务端没开密码就直接落到 token 模式，不给一个按了也没用的选项
  const [mode, setMode] = useState<"password" | "token">(passwordLogin ? "password" : "token");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = value.trim();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed || busy) return;
    setError(null);
    if (mode === "token") {
      persistToken(trimmed);
      onSuccess();
      return;
    }
    setBusy(true);
    try {
      if (await login(trimmed)) onSuccess();
      else setError("密码不对");
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  const isPw = mode === "password";
  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <h1 className="gate-title">UsageAccumulator</h1>
        <label className="gate-label" htmlFor="ua-secret">
          {isPw ? "看板密码" : "看板访问 token"}
        </label>
        <input
          id="ua-secret"
          className="gate-input"
          type="password"
          name="password"
          autoComplete="current-password"
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          placeholder={isPw ? "" : "粘贴 UA_DASHBOARD_TOKEN"}
        />
        <button className="gate-submit" type="submit" disabled={!trimmed || busy}>
          {busy ? "验证中…" : "进入"}
        </button>
        {error && <p className="gate-error">{error}</p>}
        <p className="gate-hint">
          {isPw ? "登录状态保留 30 天。" : "只存在这台设备的浏览器里，不会上传，也不在页面源码中。"}
        </p>
        {passwordLogin && (
          <button
            className="gate-alt"
            type="button"
            onClick={() => {
              setMode(isPw ? "token" : "password");
              setValue("");
              setError(null);
            }}
          >
            {isPw ? "改用 token" : "改用密码"}
          </button>
        )}
      </form>
    </div>
  );
}
