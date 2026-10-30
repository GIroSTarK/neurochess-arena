import { type ReactNode, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { AppPage } from "../routing/route-context";
import { AppNavigation } from "../shell/app-navigation";
import { AppShell } from "../shell/app-shell";
import { PageLayout, type PageWidth } from "../shell/page-layout";

import { AccountAccess } from "./account-access";

export function AccountFrame({
  title,
  children,
  page = "account",
  focusHeading = false,
  description,
  actions,
  width,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly page?: AppPage;
  readonly focusHeading?: boolean;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly width?: PageWidth;
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
      <PageLayout
        title={title}
        description={description}
        actions={actions}
        headingRef={heading}
        {...(width ? { width } : {})}
      >
        {children}
      </PageLayout>
    </AppShell>
  );
}
