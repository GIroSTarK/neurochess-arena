import type { RouteObject } from "react-router";

import { AccountApplication } from "../auth/account-application";
import { AuthRoute } from "../auth/auth-route";
import { authAction, publicLoader } from "../auth/route-data";
import { CredentialsRoute } from "../credentials/credentials-route";
import { credentialRouteData } from "../credentials/route-data";
import { HistoryRoute } from "../history/history-route";
import { historyRouteData } from "../history/route-data";
import { ArenaRoute } from "../match/arena-route";
import { arenaGameLoader, arenaSetupLoader } from "../match/route-data";
import { ProfileRoute } from "../profile/profile-route";
import { accountAction, profileLoader } from "../profile/route-data";
import { RoomEntryRoute } from "../rooms/room-entry-route";
import type { RoomEntryFeature } from "../rooms/route-data";
import { type AppRouteContext, RouteContext } from "../routing/route-context";
import { RouteNotice } from "../shell/route-notice";
import { StaticScreen } from "../shell/static-screen";

import { RouteErrorBoundary } from "./route-error-boundary";
import { RouteRoot } from "./route-root";

declare const __ARENA_REFERENCE_ENABLED__: boolean;

export function createAppRoutes(context: AppRouteContext, rooms?: RoomEntryFeature): RouteObject[] {
  const sandboxEnabled = context.sandboxEnabled && import.meta.env.SANDBOX_ENABLED === "true";
  const enabledContext = { ...context, sandboxEnabled };
  const publicPages: RouteObject[] = [
    ...(rooms
      ? [
          {
            id: "rooms-setup",
            path: "rooms",
            handle: { page: "rooms" },
            ...rooms.setup,
            element: <RoomEntryRoute feature={rooms} mode="setup" />,
          },
          {
            id: "rooms-join",
            path: "rooms/join",
            handle: { page: "rooms" },
            ...rooms.join,
            element: <RoomEntryRoute feature={rooms} mode="join" />,
          },
        ]
      : []),
    {
      id: "history",
      path: "history",
      handle: { page: "history" },
      ...historyRouteData(context),
      element: <HistoryRoute />,
    },
    {
      id: "account",
      path: "account",
      handle: { page: "account" },
      loader: profileLoader(context.runtime),
      action: accountAction(context.runtime),
      element: <ProfileRoute />,
    },
    {
      id: "credentials",
      path: "account/credentials",
      handle: { page: "account" },
      ...credentialRouteData(context),
      element: <CredentialsRoute />,
    },
    ...(["sign-in", "sign-up", "verify", "forgot-password", "reset-password"] as const).map(
      (form) => ({
        path: `auth/${form}`,
        id: `auth-${form}`,
        handle: { page: "account" },
        loader: publicLoader(context.runtime, false),
        action: authAction(context.runtime, form),
        element: <AuthRoute kind={form} />,
      }),
    ),
  ];
  return [
    {
      id: "root",
      element: (
        <RouteContext value={enabledContext}>
          <RouteRoot />
        </RouteContext>
      ),
      errorElement: (
        <RouteContext value={enabledContext}>
          <RouteErrorBoundary />
        </RouteContext>
      ),
      hydrateFallbackElement: (
        <RouteContext value={enabledContext}>
          <RouteNotice kind="loading" />
        </RouteContext>
      ),
      children: [
        {
          id: "public",
          element: <AccountApplication />,
          children: [
            {
              id: "arena",
              element: <ArenaRoute rooms={rooms} />,
              handle: { page: "arena" },
              children: [
                {
                  id: "arena-entry",
                  index: true,
                  ...arenaSetupLoader(context),
                  element: <></>,
                },
                {
                  id: "arena-game",
                  path: "games/:gameId",
                  caseSensitive: true,
                  ...arenaGameLoader(context, rooms),
                  element: <></>,
                },
              ],
            },
            ...publicPages.map((route) => ({ ...route, caseSensitive: true })),
          ],
        },
        // Literal build flags exclude the entire optional branches from the module graph.
        ...(import.meta.env.SANDBOX_ENABLED === "true" && sandboxEnabled
          ? [
              {
                id: "sandbox",
                path: "sandbox",
                caseSensitive: true,
                handle: { page: "sandbox" },
                lazy: async () => {
                  const { Component } = await loadSandboxRoute(enabledContext);
                  return { Component };
                },
                children: [
                  {
                    id: "sandbox-entry",
                    index: true,
                    element: <></>,
                    lazy: async () => {
                      return (await loadSandboxRoute(enabledContext)).entry;
                    },
                  },
                  {
                    id: "sandbox-game",
                    path: "games/:gameId",
                    caseSensitive: true,
                    element: <></>,
                    lazy: async () => {
                      return (await loadSandboxRoute(enabledContext)).game;
                    },
                  },
                ],
              } satisfies RouteObject,
            ]
          : []),
        ...(import.meta.env.DEV && __ARENA_REFERENCE_ENABLED__ && sandboxEnabled
          ? [
              {
                id: "reference",
                path: "dev/arena",
                caseSensitive: true,
                handle: { page: "reference" },
                lazy: async () => {
                  try {
                    const { ArenaReferenceScreen } =
                      await import("../reference/arena-reference-screen");
                    return { Component: ArenaReferenceScreen };
                  } catch {
                    throw new Error("ROUTE_MODULE_UNAVAILABLE");
                  }
                },
              } satisfies RouteObject,
            ]
          : []),
        {
          path: "*",
          handle: { page: "not-found" },
          element: <StaticScreen page="not-found" />,
        },
      ],
    },
  ];
}

async function loadSandboxRoute(context: AppRouteContext) {
  try {
    const [{ SandboxRoute }, { sandboxEntryLoader, sandboxGameLoader }] = await Promise.all([
      import("../sandbox/sandbox-route"),
      import("../sandbox/route-data"),
    ]);
    return {
      Component: SandboxRoute,
      entry: sandboxEntryLoader(context),
      game: sandboxGameLoader(context),
    };
  } catch {
    throw new Error("ROUTE_MODULE_UNAVAILABLE");
  }
}
