import { useTranslation } from "react-i18next";

import { cx } from "../ui/cx";

import type { AppPage } from "./navigation";

export function AppNavigation({
  page,
  sandboxEnabled,
}: {
  readonly page: AppPage;
  readonly sandboxEnabled: boolean;
}) {
  const { t } = useTranslation();
  const links = [
    { page: "arena", href: "/", label: t("app.arena") },
    ...(sandboxEnabled ? [{ page: "sandbox", href: "/sandbox", label: t("sandbox.title") }] : []),
  ];
  return links.map((link) => (
    <a
      key={link.page}
      href={link.href}
      aria-current={page === link.page ? "page" : undefined}
      className={cx(
        "flex min-h-11 items-center border-b-2 px-1 text-label md:min-h-18",
        page === link.page
          ? "border-accent text-text"
          : "border-transparent text-text-secondary hover:border-control-border hover:text-text",
      )}
    >
      {link.label}
    </a>
  ));
}
