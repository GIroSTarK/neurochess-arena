import { createContext, useContext } from "react";

import type { AuthEntry } from "../auth/auth-entry";

import type { RouteNavigation } from "./route-navigation";
import type { RouteRuntime } from "./route-runtime";

export type AppPage =
  "arena" | "rooms" | "account" | "history" | "sandbox" | "reference" | "not-found";

export interface RouteMetadata {
  readonly page: AppPage;
}

export interface AppRouteContext {
  readonly apiBaseUrl: string;
  readonly sandboxEnabled: boolean;
  readonly authEntry?: AuthEntry;
  readonly navigation: RouteNavigation;
  readonly runtime: RouteRuntime;
}

export const RouteContext = createContext<AppRouteContext | null>(null);
export const PageContext = createContext<AppPage | null>(null);

export function useAppRoute() {
  const context = useContext(RouteContext);
  if (!context) throw new Error("Route context required");
  return context;
}
