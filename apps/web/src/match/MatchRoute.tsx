import { useLayoutEffect } from "react";
import { useRevalidator, useRouteLoaderData } from "react-router";

import { type AiIdentity, createAiApi } from "../api/ai-client";
import { useGameRouteController } from "../app/useGameRouteController";

import { MatchController } from "./controller";
import { MatchScreen } from "./MatchScreen";
import type { ArenaRouteData } from "./route-data";

export function MatchRoute({
  apiBaseUrl,
  sandboxEnabled,
  identity,
}: {
  readonly apiBaseUrl: string;
  readonly sandboxEnabled: boolean;
  readonly identity: AiIdentity;
}) {
  const gameData = useRouteLoaderData<ArenaRouteData>("arena-game");
  const setupData = useRouteLoaderData<ArenaRouteData>("arena-entry");
  const result = gameData ?? setupData;
  const revalidator = useRevalidator();
  const { controller, stopped, retry } = useGameRouteController(
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
      apiBaseUrl={apiBaseUrl}
      sandboxEnabled={sandboxEnabled}
      identity={identity}
      stopped={stopped}
      onRetry={retry}
      entry={result?.data ?? null}
    />
  );
}
