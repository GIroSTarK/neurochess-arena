import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Icon } from "../ui/Icon";

import { AppNavigation } from "./AppNavigation";
import { AppShell } from "./AppShell";

export function StaticScreen({
  page,
  sandboxEnabled,
}: {
  readonly page: "arena" | "not-found";
  readonly sandboxEnabled: boolean;
}) {
  const { t } = useTranslation();
  const isArena = page === "arena";
  return (
    <AppShell
      mainId="main"
      skipLabel={t("app.skipLink")}
      context={isArena ? t("arena.status") : null}
      navigation={<AppNavigation page={page} sandboxEnabled={sandboxEnabled} />}
      footer={null}
      announcement=""
    >
      <section className="mx-auto mt-8 grid min-h-100 max-w-[1120px] content-center justify-items-center gap-6 px-6 py-12 text-center md:mt-12 md:min-h-120 md:px-12">
        <span className="flex size-14 items-center justify-center rounded-control border border-control-border bg-surface text-accent">
          <Icon path="M9 3h6l-1 5 3 4v3H7v-3l3-4-1-5ZM8 15l-2 6h12l-2-6M8 3h8" />
        </span>
        <h1 className="font-display text-display font-medium max-sm:text-title">
          {isArena ? t("app.arena") : t("notFound.title")}
        </h1>
        {isArena ? <h2 className="text-section font-medium">{t("arena.headline")}</h2> : null}
        <p className="max-w-xl text-body text-text-secondary">
          {isArena ? t("arena.description") : t("notFound.description")}
        </p>
        {isArena && sandboxEnabled ? (
          <Link
            to="/sandbox"
            className="inline-flex min-h-11 items-center justify-center rounded-control border border-control-border bg-surface px-5 py-2 text-label font-medium text-text hover:bg-surface-raised"
          >
            {t("arena.openSandbox")}
          </Link>
        ) : !isArena ? (
          <Link
            to="/"
            className="inline-flex min-h-11 items-center px-4 py-2 text-label text-accent underline underline-offset-4"
          >
            {t("notFound.backToArena")}
          </Link>
        ) : null}
      </section>
    </AppShell>
  );
}
