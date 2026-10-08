import { useLayoutEffect } from "react";
import { useRevalidator, useRouteLoaderData } from "react-router";

import { createAiApi } from "../api/ai-client";
import type { AiIdentity } from "../api/identity";
import { useGameRouteController } from "../routing/use-game-route-controller";

import { MatchController } from "./controller";
import { MatchScreen } from "./match-screen";
import type { ArenaRouteData } from "./route-data";

export function MatchRoute({
  apiBaseUrl,
  identity,
}: {
  readonly apiBaseUrl: string;
  readonly identity: AiIdentity;
}) {
  const gameData = useRouteLoaderData<ArenaRouteData>("arena-game");
  const setupData = useRouteLoaderData<ArenaRouteData>("arena-entry");
  const result = gameData ?? setupData;
  const revalidator = useRevalidator();
  const { controller, stopped, departing, retry } = useGameRouteController(
    "arena",
    (navigation) =>
      new MatchController(createAiApi(apiBaseUrl, { identity }), undefined, navigation),
    (controller) => {
      const entry = result?.data?.entry;
      if (entry && entry.kind !== "handoff") void controller.enter(entry);
    },
    identity.signal,
    {
      data: result,
      refresh: () => {
        void revalidator.revalidate();
      },
    },
  );
  const entry = result?.data?.entry;
  const accessDenied = entry?.kind === "unavailable" && entry.code === "access";
  useLayoutEffect(() => {
    // A fresh denial revokes the visible private view even when ordinary
    // revalidation would leave the live controller's newer snapshot alone.
    if (accessDenied && !stopped) void controller.enter({ kind: "unavailable", code: "access" });
  }, [controller, accessDenied, stopped]);
  return (
    <MatchScreen
      controller={controller}
      identity={identity}
      stopped={stopped}
      departing={departing}
      onRetry={retry}
      entry={result?.data ?? null}
    />
  );
}
