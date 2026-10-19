import { useEffect, useState } from "react";

export const ROUTES = ["overview", "weeks", "windows", "distribution"] as const;
export type RouteId = (typeof ROUTES)[number];

function parse(): RouteId {
  const raw = globalThis.location?.hash.replace(/^#\/?/, "") ?? "";
  return (ROUTES as readonly string[]).includes(raw) ? (raw as RouteId) : "overview";
}

export function useRoute(): RouteId {
  const [route, setRoute] = useState<RouteId>(parse);
  useEffect(() => {
    const onHash = () => setRoute(parse());
    globalThis.addEventListener("hashchange", onHash);
    return () => globalThis.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

export const hrefFor = (r: RouteId): string => `#/${r}`;
