import { useTranslation } from "react-i18next";

import { AppNavigation } from "./AppNavigation";
import { AppShell } from "./AppShell";

export function SandboxLoadingScreen() {
  const { t } = useTranslation();
  return (
    <AppShell
      mainId="sandbox"
      skipLabel={t("sandbox.skipLink")}
      context={t("app.localDevelopment")}
      navigation={<AppNavigation page="sandbox" sandboxEnabled />}
      footer={null}
      announcement={t("sandbox.loading")}
    >
      <section className="grid min-h-100 content-center justify-items-center gap-6 px-6 py-12 text-center">
        <h1 className="font-display text-title font-medium">{t("sandbox.title")}</h1>
        <p className="text-text-secondary">{t("sandbox.loading")}</p>
      </section>
    </AppShell>
  );
}
