import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { GameRouteLifetime } from "./game-route-lifetime";
import type { GameTarget } from "./navigation";
import { useAppRoute } from "./route-context";
import { gameRouteTarget } from "./route-navigation";
import type { GameMode } from "./route-urls";

export function useGameRouteController<T extends { endLifetime(): void }>(
  mode: GameMode,
  create: ConstructorParameters<typeof GameRouteLifetime<T>>[1],
  enter: (controller: T, target: GameTarget) => void,
  signal: AbortSignal | undefined,
  entry: { readonly data: unknown; readonly refresh: () => void },
) {
  const navigate = useNavigate();
  const location = useLocation();
  const { gameId } = useParams();
  const context = useAppRoute();
  const [lifetime] = useState(
    () =>
      new GameRouteLifetime(
        mode,
        create,
        enter,
        (href, replace) => {
          // Adopt the handoff before another history action can target the previous leaf.
          void navigate(href, { replace, flushSync: true });
        },
        context.navigation,
      ),
  );
  const stopped = useSyncExternalStore(lifetime.subscribe, lifetime.getSnapshot);
  // A loaded handoff and immediate Back can both commit before React renders.
  // Reconnect that history entry even if its final target matches the previous render.
  const target = gameRouteTarget(mode, location, gameId);
  const routeRevision = lifetime.getRouteRevision(target);
  const key = target.kind === "game" ? target.gameId : target.kind;
  useLayoutEffect(() => lifetime.updateEntry(enter, entry.data, entry.refresh));
  useLayoutEffect(
    () =>
      lifetime.connect(
        key === "none" || key === "invalid" ? { kind: key } : { kind: "game", gameId: key },
        signal,
      ),
    [lifetime, key, signal, routeRevision],
  );
  // Adopt route handoffs during layout, but start reads after commit so StrictMode
  // can cancel its first effect setup before any recovery command is dispatched.
  useEffect(() => lifetime.activate(), [lifetime, key, signal, entry.data, routeRevision]);
  useLayoutEffect(() => () => lifetime.end(), [lifetime]);
  return { controller: lifetime.controller, stopped, retry: lifetime.retry };
}
