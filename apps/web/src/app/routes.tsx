import type { RouteObject } from "react-router";

import { AccountApplication } from "../auth/AccountApplication";
import { AuthRoute } from "../auth/AuthRoute";
import { authAction, publicLoader } from "../auth/route-data";
import { CredentialsRoute } from "../credentials/CredentialsRoute";
import { credentialRouteData } from "../credentials/route-data";
import { HistoryRoute } from "../history/HistoryRoute";
import { historyRouteData } from "../history/route-data";
import { ArenaRoute } from "../match/ArenaRoute";
import { arenaGameLoader, arenaSetupLoader } from "../match/route-data";
import { ProfileRoute } from "../profile/ProfileRoute";
import { accountAction, profileLoader } from "../profile/route-data";

import { type AppRouteContext, RouteContext } from "./route-context";
import { RouteErrorBoundary } from "./RouteErrorBoundary";
import { RouteNotice } from "./RouteNotice";
import { RouteRoot } from "./RouteRoot";
import { StaticScreen } from "./StaticScreen";

declare const __ARENA_REFERENCE_ENABLED__: boolean;

export function createAppRoutes(context: AppRouteContext): RouteObject[] {
  const sandboxEnabled = context.sandboxEnabled && import.meta.env.SANDBOX_ENABLED === "true";
  const enabledContext = { ...context, sandboxEnabled };
  const publicPages: RouteObject[] = [
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
      errorElement: <RouteErrorBoundary sandboxEnabled={sandboxEnabled} />,
      hydrateFallbackElement: <RouteNotice kind="loading" sandboxEnabled={sandboxEnabled} />,
      children: [
        {
          id: "public",
          element: <AccountApplication />,
          children: [
            {
              id: "arena",
              element: <ArenaRoute />,
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
                  ...arenaGameLoader(context),
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
                      await import("../reference/ArenaReferenceScreen");
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
          element: <StaticScreen page="not-found" sandboxEnabled={sandboxEnabled} />,
        },
      ],
    },
  ];
}

async function loadSandboxRoute(context: AppRouteContext) {
  try {
    const [{ SandboxRoute }, { sandboxEntryLoader, sandboxGameLoader }] = await Promise.all([
      import("../sandbox/SandboxRoute"),
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
