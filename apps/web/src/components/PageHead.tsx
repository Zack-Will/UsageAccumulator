import type { WindowState } from "../api";
import { greeting, headline } from "./headline";

/** 总览页首：衬线问候 + 一句当前最要紧的事（见 headline.ts）。不是卡片，横跨整行。 */
export function PageHead({ windows, nowMs }: { windows: readonly WindowState[] | null; nowMs: number }) {
  const h = windows ? headline(windows, nowMs) : null;
  return (
    <header className="page-head">
      <h1 className="page-head__title">{greeting(nowMs)}</h1>
      {h && (
        <p className={`page-head__line page-head__line--${h.tone}`}>
          {h.parts.map((p, i) => (typeof p === "string" ? <span key={i}>{p}</span> : <strong key={i}>{p.strong}</strong>))}
        </p>
      )}
    </header>
  );
}
