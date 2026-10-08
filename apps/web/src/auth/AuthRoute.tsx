import { useLocation } from "react-router";

import { useAppRoute } from "../app/route-context";
import type { AuthForm } from "../app/route-urls";

import { AuthScreen } from "./AuthScreen";
import { useRouteAuthEntry } from "./useRouteAuthEntry";

export function AuthRoute({ kind }: { readonly kind: AuthForm }) {
  const { authEntry } = useAppRoute();
  const location = useLocation();
  const entry = useRouteAuthEntry(authEntry);
  return <AuthScreen key={kind + location.pathname + location.search} kind={kind} entry={entry} />;
}
