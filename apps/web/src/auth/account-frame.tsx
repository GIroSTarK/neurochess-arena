import { type ReactNode, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { AppPage } from "../routing/route-context";
import { AppNavigation } from "../shell/app-navigation";
import { AppShell } from "../shell/app-shell";

import { AccountAccess } from "./account-access";

export function AccountFrame({
  title,
  children,
  page = "account",
  focusHeading = false,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly page?: AppPage;
  readonly focusHeading?: boolean;
}) {
  const { t } = useTranslation();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusHeading) heading.current?.focus({ preventScroll: true });
  }, [focusHeading, title]);
  return (
    <AppShell
      mainId="account-main"
      skipLabel={t("app.skipLink")}
      context={<AccountAccess />}
      navigation={<AppNavigation page={page} />}
      footer={t("account.footer")}
      announcement=""
    >
      <section className="mx-auto my-8 grid w-full max-w-xl min-w-0 gap-6 rounded-panel border border-divider bg-surface p-4 md:p-8">
        <h1 ref={heading} tabIndex={-1} className="font-display text-title font-medium">
          {title}
        </h1>
        {children}
      </section>
    </AppShell>
  );
}
