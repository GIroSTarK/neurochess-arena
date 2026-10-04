import { createBrowserRouter, type RouteObject } from "react-router";

import type { AuthEntry } from "../auth/navigation";

import { RouteNavigation } from "./route-navigation";
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
  const router = factory(createAppRoutes({ ...options, navigation }));
  const initial = router.state.location;
  router.subscribe((state) => {
    const destination = state.navigation.location ?? state.location;
    navigation.departing(destination);
    if (destination.pathname !== initial.pathname || destination.search !== initial.search) {
      options.authEntry?.retire();
    }
  });
  return router;
}
