import type { RouteObject } from "react-router";

import { MatchRouteLayout } from "../match/MatchRouteLayout";

import { type AppRouteContext, RouteContext } from "./route-context";
import { RouteErrorBoundary } from "./RouteErrorBoundary";
import { RouteNotice } from "./RouteNotice";
import { PublicRoute, RouteRoot } from "./RouteRoot";
import { StaticScreen } from "./StaticScreen";

declare const __ARENA_REFERENCE_ENABLED__: boolean;

export function createAppRoutes(context: AppRouteContext): RouteObject[] {
  const sandboxEnabled = context.sandboxEnabled && import.meta.env.SANDBOX_ENABLED === "true";
  const enabledContext = { ...context, sandboxEnabled };
  const publicPages: RouteObject[] = [
    { path: "history", handle: { page: "history", accountPage: "history" } },
    { path: "account", handle: { page: "account", accountPage: "profile" } },
    { path: "account/credentials", handle: { page: "account", accountPage: "credentials" } },
    ...(["sign-in", "sign-up", "verify", "forgot-password", "reset-password"] as const).map(
      (form) => ({
        path: `auth/${form}`,
        handle: { page: "account", accountPage: "auth", form },
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
          element: <PublicRoute />,
          children: [
            {
              id: "arena",
              element: <MatchRouteLayout />,
              handle: { page: "arena", accountPage: "arena" },
              children: [
                { index: true, element: <></> },
                { path: "games/:gameId", caseSensitive: true, element: <></> },
              ],
            },
            ...publicPages.map((route) => ({ ...route, caseSensitive: true, element: <></> })),
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
                  try {
                    const { SandboxRouteLayout } = await import("../game/SandboxRouteLayout");
                    return { Component: SandboxRouteLayout };
                  } catch {
                    throw new Error("ROUTE_MODULE_UNAVAILABLE");
                  }
                },
                children: [
                  { index: true, element: <></> },
                  { path: "games/:gameId", caseSensitive: true, element: <></> },
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
