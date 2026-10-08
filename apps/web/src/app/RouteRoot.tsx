import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useMatches, useParams } from "react-router";

import { DocumentMetadata } from "./DocumentMetadata";
import { PageContext, type RouteMetadata, useAppRoute } from "./route-context";
import { gameRouteTarget } from "./route-navigation";
import { RouteEffects } from "./RouteEffects";
import { StaticScreen } from "./StaticScreen";

function useMetadata(): RouteMetadata {
  const matches = useMatches();
  return (
    (matches.findLast((match) => match.handle)?.handle as RouteMetadata | undefined) ?? {
      page: "not-found",
    }
  );
}

export function RouteRoot() {
  const { t } = useTranslation();
  const context = useAppRoute();
  const metadata = useMetadata();
  const location = useLocation();
  const params = useParams();
  const invalid =
    (metadata.page === "arena" || metadata.page === "sandbox") &&
    gameRouteTarget(metadata.page, location, params.gameId).kind === "invalid";
  const page = invalid ? "not-found" : metadata.page;
  return (
    <PageContext value={page}>
      <DocumentMetadata page={page} />
      <RouteEffects navigation={context.navigation} pendingLabel={t("routing.pending")} />
      {invalid ? <StaticScreen page="not-found" /> : <Outlet />}
    </PageContext>
  );
}
