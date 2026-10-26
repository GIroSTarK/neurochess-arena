import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useMatches, useParams } from "react-router";

import { PageContext, type RouteMetadata, useAppRoute } from "../routing/route-context";
import { RouteEffects } from "../routing/route-effects";
import { gameRouteTarget } from "../routing/route-navigation";
import { DocumentMetadata } from "../shell/document-metadata";
import { NotFoundScreen } from "../shell/not-found-screen";

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
      {invalid ? <NotFoundScreen /> : <Outlet />}
    </PageContext>
  );
}
