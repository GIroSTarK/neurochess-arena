import { type ReactNode, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { AppNavigation } from "../app/AppNavigation";
import { AppShell } from "../app/AppShell";

import { AccountAccess } from "./AccountAccess";

export function AccountLayout({
  title,
  children,
  sandboxEnabled,
  announcement = "",
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly sandboxEnabled: boolean;
  readonly announcement?: string;
}) {
  const { t } = useTranslation();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <AppShell
      mainId="account-main"
      skipLabel={t("app.skipLink")}
      context={<AccountAccess />}
      footer={t("auth.private")}
      announcement={announcement}
      navigation={<AppNavigation page="account" sandboxEnabled={sandboxEnabled} />}
    >
      <section className="mx-auto my-8 grid w-full max-w-[560px] min-w-0 gap-6 rounded-panel border border-divider bg-surface p-4 md:my-12 md:p-8">
        <h1
          ref={heading}
          tabIndex={-1}
          className="font-display text-title font-semibold outline-none"
        >
          {title}
        </h1>
        {children}
      </section>
    </AppShell>
  );
}
