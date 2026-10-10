import { createBrowserRouter, matchRoutes, type RouteObject } from "react-router";

import { createAuthApi } from "../api/auth-client";
import type { AuthEntry } from "../auth/auth-entry";
import { consumeRoomInvitation } from "../rooms/invitation";
import { roomRouteData } from "../rooms/route-data";
import { RouteNavigation } from "../routing/route-navigation";
import { gameRouteKey } from "../routing/route-navigation";
import { RouteRuntime } from "../routing/route-runtime";

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
  const context = { ...options, navigation, runtime };
  const rooms = roomRouteData(context, consumeRoomInvitation());
  const router = factory(createAppRoutes(context, rooms));
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
  let visited = initial;
  const unsubscribeRouter = router.subscribe((state) => {
    const destination = state.navigation.location ?? state.location;
    runtime.navigating(destination);
    navigation.departing(destination);
    if (state.navigation.state === "idle") navigation.arrived(state.location);
    const samePage =
      destination.pathname === visited.pathname && destination.search === visited.search;
    if (destination.key !== visited.key || !samePage) {
      // An auth redirect or link back to the landing path is a new visit and must not keep its
      // callback notice or reset input. A fragment-only skip link, or a submission to the
      // current page whose action still reads that input, stays on the same visit.
      const sameVisit =
        samePage &&
        (destination.hash !== visited.hash || state.navigation.formMethod !== undefined);
      if (!sameVisit) options.authEntry?.retire();
      visited = destination;
    }
    if (!isPublic(destination)) runtime.stop();
    revalidateIdentity();
  });
  const dispose = router.dispose.bind(router);
  router.dispose = () => {
    disposed = true;
    unsubscribeAccount();
    unsubscribeRouter();
    rooms.dispose();
    runtime.dispose();
    dispose();
  };
  return router;
}
