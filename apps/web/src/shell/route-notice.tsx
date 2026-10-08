import { useTranslation } from "react-i18next";

import { Button } from "../ui/button";

import { AppNavigation } from "./app-navigation";
import { AppShell } from "./app-shell";

export function RouteNotice({
  kind,
  onRetry,
}: {
  readonly kind: "loading" | "error" | "stopped";
  readonly onRetry?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AppShell
      mainId="route-notice"
      skipLabel={t("app.skipLink")}
      navigation={<AppNavigation page="not-found" />}
      context={null}
      footer={null}
      announcement={t(`routing.${kind}`)}
    >
      <section className="grid min-h-100 content-center justify-items-center gap-6 px-6 py-12 text-center">
        <h1 className="font-display text-title font-medium">{t(`routing.${kind}`)}</h1>
        {onRetry ? (
          <Button variant="primary" onClick={onRetry}>
            {t(kind === "error" ? "routing.reload" : "routing.retry")}
          </Button>
        ) : null}
      </section>
    </AppShell>
  );
}
