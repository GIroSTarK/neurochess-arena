import { createContext, useContext } from "react";

import type { AuthEntry } from "../auth/navigation";

import type { AccountPage, AppPage } from "./navigation";
import type { RouteNavigation } from "./route-navigation";
import type { AuthForm } from "./route-urls";

export interface RouteMetadata {
  readonly page: AppPage;
  readonly accountPage?: AccountPage;
  readonly form?: AuthForm;
}

export interface AppRouteContext {
  readonly apiBaseUrl: string;
  readonly sandboxEnabled: boolean;
  readonly authEntry?: AuthEntry;
  readonly navigation: RouteNavigation;
}

export const RouteContext = createContext<AppRouteContext | null>(null);
export const PageContext = createContext<AppPage | null>(null);

export function useAppRoute() {
  const context = useContext(RouteContext);
  if (!context) throw new Error("Route context required");
  return context;
}
