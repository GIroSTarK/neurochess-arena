import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cx } from "../ui/cx";

interface AppShellProps {
  readonly mainId: string;
  readonly skipLabel: string;
  readonly context: ReactNode;
  readonly footer: ReactNode;
  readonly announcement: string;
  readonly navigation?: ReactNode;
  readonly children: ReactNode;
}

export function AppShell({
  mainId,
  skipLabel,
  context,
  footer,
  announcement,
  navigation,
  children,
}: AppShellProps) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto w-[min(1280px,calc(100%_-_2rem))] pb-[max(1.5rem,env(safe-area-inset-bottom))] md:w-[min(1280px,calc(100%_-_3rem))] lg:w-[min(1280px,calc(100%_-_4rem))]">
      <a
        className="fixed top-3 left-4 z-10 -translate-y-[200%] rounded-control bg-accent p-3 text-on-accent focus:translate-y-0"
        href={`#${mainId}`}
      >
        {skipLabel}
      </a>
      <header
        className={cx(
          "flex flex-wrap items-center justify-between gap-6 border-b border-divider max-sm:gap-3",
          navigation ? "min-h-18" : "min-h-22 py-3 max-sm:min-h-19",
        )}
      >
        <div className="flex min-w-0 items-center gap-14 self-stretch">
          <p
            className={cx(
              "font-display font-semibold tracking-[0.035em] uppercase max-sm:max-w-44",
              navigation ? "text-wordmark max-sm:text-label" : "text-body max-sm:text-caption",
            )}
          >
            <span className="inline-block">{t("app.brand")}</span>{" "}
            <span className="inline-block text-accent">{t("app.arena")}</span>
          </p>
          {navigation ? (
            <nav className="hidden self-stretch md:flex" aria-label={t("app.navigation")}>
              {navigation}
            </nav>
          ) : null}
        </div>
        <span className="text-right text-label text-text-muted max-sm:max-w-32 max-sm:text-caption">
          {context}
        </span>
      </header>
      <main id={mainId} tabIndex={-1}>
        {children}
      </main>
      <footer className="pt-8 text-center text-caption text-text-muted">{footer}</footer>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}
