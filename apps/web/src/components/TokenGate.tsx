import { useState } from "react";
import { persistToken } from "../api";

/**
 * live 模式下没有 token 时挡在前面的输入口。
 *
 * 之所以需要它：看板现在由服务端在公网托管，token 不能打进 JS 产物（谁都能读），
 * 只能由使用者在自己浏览器里输入一次，存 localStorage。
 */
export function TokenGate({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();

  return (
    <div className="gate">
      <form
        className="gate-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed) return;
          persistToken(trimmed);
          onSaved();
        }}
      >
        <h1 className="gate-title">UsageAccumulator</h1>
        <label className="gate-label" htmlFor="ua-token">
          看板访问 token
        </label>
        <input
          id="ua-token"
          className="gate-input"
          type="password"
          autoComplete="current-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="粘贴 UA_DASHBOARD_TOKEN"
        />
        <button className="gate-submit" type="submit" disabled={!trimmed}>
          进入
        </button>
        <p className="gate-hint">只存在这台设备的浏览器里，不会上传，也不在页面源码中。</p>
      </form>
    </div>
  );
}
