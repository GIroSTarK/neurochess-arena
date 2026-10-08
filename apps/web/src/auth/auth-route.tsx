import { useLocation } from "react-router";

import { useAppRoute } from "../routing/route-context";
import type { AuthForm } from "../routing/route-urls";

import { AuthScreen } from "./auth-screen";
import { useRouteAuthEntry } from "./use-route-auth-entry";

export function AuthRoute({ kind }: { readonly kind: AuthForm }) {
  const { authEntry } = useAppRoute();
  const location = useLocation();
  const entry = useRouteAuthEntry(authEntry);
  return <AuthScreen key={kind + location.pathname + location.search} kind={kind} entry={entry} />;
}
