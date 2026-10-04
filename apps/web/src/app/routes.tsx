import type { RouteObject } from "react-router";

import { AccountApplication } from "../auth/AccountApplication";
import {
  ArenaRoute,
  AuthRoute,
  CredentialsRoute,
  HistoryRoute,
  ProfileRoute,
} from "../auth/AccountRoutes";
import { authAction, publicLoader } from "../auth/route-data";

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
      loader: publicLoader(context.runtime, true),
      element: <HistoryRoute />,
    },
    {
      id: "account",
      path: "account",
      handle: { page: "account" },
      loader: publicLoader(context.runtime, false),
      action: authAction(context.runtime),
      element: <ProfileRoute />,
    },
    {
      id: "credentials",
      path: "account/credentials",
      handle: { page: "account" },
      loader: publicLoader(context.runtime, false),
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
                  loader: publicLoader(context.runtime, true, true),
                  element: <></>,
                },
                {
                  id: "arena-game",
                  path: "games/:gameId",
                  caseSensitive: true,
                  loader: publicLoader(context.runtime, true, true),
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
