import { type ReactNode, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { AppNavigation } from "../app/AppNavigation";
import { AppShell } from "../app/AppShell";
import type { AppPage } from "../app/navigation";

import { AccountAccess } from "./AccountAccess";

export function AccountFrame({
  title,
  children,
  sandboxEnabled,
  page = "account",
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly sandboxEnabled: boolean;
  readonly page?: AppPage;
}) {
  const { t } = useTranslation();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [title]);
  return (
    <AppShell
      mainId="account-main"
      skipLabel={t("app.skipLink")}
      context={<AccountAccess />}
      navigation={<AppNavigation page={page} sandboxEnabled={sandboxEnabled} />}
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
