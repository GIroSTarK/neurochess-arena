import { useTranslation } from "react-i18next";

import { Icon } from "../ui/icon";
import { TextLink } from "../ui/text-link";

import { AppNavigation } from "./app-navigation";
import { AppShell } from "./app-shell";

export function NotFoundScreen() {
  const { t } = useTranslation();
  return (
    <AppShell
      mainId="main"
      skipLabel={t("app.skipLink")}
      context={null}
      navigation={<AppNavigation page="not-found" />}
      footer={null}
      announcement=""
    >
      <section className="mx-auto mt-8 grid min-h-100 max-w-[1120px] content-center justify-items-center gap-6 px-6 py-12 text-center md:mt-12 md:min-h-120 md:px-12">
        <span className="flex size-14 items-center justify-center rounded-control border border-control-border bg-surface text-accent">
          <Icon path="M9 3h6l-1 5 3 4v3H7v-3l3-4-1-5ZM8 15l-2 6h12l-2-6M8 3h8" />
        </span>
        <h1 className="font-display text-display font-medium max-sm:text-title">
          {t("notFound.title")}
        </h1>
        <p className="max-w-xl text-body text-text-secondary">{t("notFound.description")}</p>
        <TextLink to="/" className="px-4 py-2 text-label underline-offset-4">
          {t("notFound.backToArena")}
        </TextLink>
      </section>
    </AppShell>
  );
}
