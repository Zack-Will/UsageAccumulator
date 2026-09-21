import { useEffect, useRef, useState } from "react";

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** 数字补间：刷新时不跳变（ARCHITECTURE §8 美学基线）。 */
export function useTween(target: number, ms = 300): number {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    if (!Number.isFinite(target) || !Number.isFinite(from) || from === target) {
      fromRef.current = target;
      setValue(target);
      return;
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const v = from + (target - from) * easeOutCubic(p);
      fromRef.current = v;
      setValue(v);
      if (p < 1) rafRef.current = requestAnimationFrame(step);
      else fromRef.current = target;
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, ms]);

  return value;
}
