import { useMemo } from "react";
import { useLocation } from "react-router";

import { type AuthEntry, readAuthEntry } from "./auth-entry";

export function useRouteAuthEntry(bootstrap?: AuthEntry) {
  const location = useLocation();
  return useMemo(
    () =>
      bootstrap?.active
        ? bootstrap
        : readAuthEntry(new URL(location.pathname + location.search, "https://arena.invalid")),
    [bootstrap, location.pathname, location.search],
  );
}
