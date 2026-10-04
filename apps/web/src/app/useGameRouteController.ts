import { useContext, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { GameRouteLifetime } from "./game-route-lifetime";
import type { GameTarget } from "./navigation";
import { RouteContext } from "./route-context";
import { gameRouteTarget, RouteNavigation } from "./route-navigation";
import type { GameMode } from "./route-urls";

export function useGameRouteController<T extends { endLifetime(): void }>(
  mode: GameMode,
  create: ConstructorParameters<typeof GameRouteLifetime<T>>[1],
  enter: (controller: T, target: GameTarget) => void,
  signal?: AbortSignal,
) {
  const navigate = useNavigate();
  const location = useLocation();
  const { gameId } = useParams();
  const context = useContext(RouteContext);
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
        context?.navigation ?? new RouteNavigation(),
      ),
  );
  const stopped = useSyncExternalStore(lifetime.subscribe, lifetime.getSnapshot);
  const target = gameRouteTarget(mode, location, gameId);
  const key = target.kind === "game" ? target.gameId : target.kind;
  useLayoutEffect(
    () =>
      lifetime.connect(
        key === "none" || key === "invalid" ? { kind: key } : { kind: "game", gameId: key },
        signal,
      ),
    [lifetime, key, signal],
  );
  useLayoutEffect(() => () => lifetime.end(), [lifetime]);
  return { controller: lifetime.controller, stopped, retry: lifetime.retry };
}
