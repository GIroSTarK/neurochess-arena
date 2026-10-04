import { createBrowserRouter, matchRoutes, type RouteObject } from "react-router";

import { createAuthApi } from "../api/auth-client";
import type { AuthEntry } from "../auth/navigation";

import { RouteNavigation } from "./route-navigation";
import { gameRouteKey } from "./route-navigation";
import { RouteRuntime } from "./route-runtime";
import { createAppRoutes } from "./routes";

export interface AppRouterOptions {
  readonly apiBaseUrl: string;
  readonly sandboxEnabled: boolean;
  readonly authEntry?: AuthEntry;
}

export function createAppRouter(
  options: AppRouterOptions,
  factory: (routes: RouteObject[]) => ReturnType<typeof createBrowserRouter> = createBrowserRouter,
) {
  const navigation = new RouteNavigation();
  const runtime = new RouteRuntime(createAuthApi(options.apiBaseUrl), options.authEntry);
  const router = factory(createAppRoutes({ ...options, navigation, runtime }));
  const initial = router.state.location;
  runtime.navigating(initial);
  let disposed = false;
  const isPublic = (location: typeof initial) => {
    const matches = matchRoutes(router.routes, location);
    return (
      matches?.some((match) => match.route.id === "public") &&
      (!matches.some((match) => match.route.id === "arena") ||
        gameRouteKey("arena", location) !== null)
    );
  };
  const revalidateIdentity = () => {
    queueMicrotask(() => {
      const state = router.state;
      const account = runtime.account.getSnapshot();
      if (
        disposed ||
        !isPublic(state.navigation.location ?? state.location) ||
        account.phase === "checking" ||
        account.phase === "changing" ||
        state.navigation.state !== "idle" ||
        state.revalidation !== "idle" ||
        [...state.fetchers.values()].some((fetcher) => fetcher.state !== "idle")
      ) {
        return;
      }
      const stale = Object.values(state.loaderData).some((value: unknown) => {
        return (
          typeof value === "object" &&
          value !== null &&
          "generation" in value &&
          "data" in value &&
          (value.generation !== account.revision || value.data === null)
        );
      });
      if (stale) void router.revalidate();
    });
  };
  const unsubscribeAccount = runtime.account.subscribe(revalidateIdentity);
  const unsubscribeRouter = router.subscribe((state) => {
    const destination = state.navigation.location ?? state.location;
    runtime.navigating(destination);
    navigation.departing(destination);
    if (destination.pathname !== initial.pathname || destination.search !== initial.search) {
      options.authEntry?.retire();
    }
    if (!isPublic(destination)) runtime.stop();
    revalidateIdentity();
  });
  const dispose = router.dispose.bind(router);
  router.dispose = () => {
    disposed = true;
    unsubscribeAccount();
    unsubscribeRouter();
    runtime.dispose();
    dispose();
  };
  return router;
}
