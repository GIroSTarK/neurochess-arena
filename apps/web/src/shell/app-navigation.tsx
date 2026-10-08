import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import type { AppPage } from "../routing/route-context";
import { PageContext, useAppRoute } from "../routing/route-context";
import { cx } from "../ui/cx";

export function AppNavigation({ page }: { readonly page: AppPage }) {
  const { t } = useTranslation();
  const { sandboxEnabled } = useAppRoute();
  const routePage = useContext(PageContext) ?? page;
  const links = [
    { page: "arena", href: "/", label: t("app.arena") },
    { page: "history", href: "/history", label: t("history.navigation") },
    ...(sandboxEnabled ? [{ page: "sandbox", href: "/sandbox", label: t("sandbox.title") }] : []),
  ];
  return links.map((link) => (
    <Link
      key={link.page}
      to={link.href}
      aria-current={routePage === link.page ? "page" : undefined}
      className={cx(
        "flex min-h-11 items-center border-b-2 px-1 text-label md:min-h-18",
        routePage === link.page
          ? "border-accent text-text"
          : "border-transparent text-text-secondary hover:border-control-border hover:text-text",
      )}
    >
      {link.label}
    </Link>
  ));
}
