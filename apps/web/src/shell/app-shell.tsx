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
    <div className="mx-auto w-full max-w-[1344px] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(1.5rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] md:pr-[max(1.5rem,env(safe-area-inset-right))] md:pl-[max(1.5rem,env(safe-area-inset-left))] lg:pr-[max(2rem,env(safe-area-inset-right))] lg:pl-[max(2rem,env(safe-area-inset-left))]">
      <a
        className="fixed top-3 left-4 z-10 -translate-y-[200%] rounded-control bg-accent p-3 text-on-accent focus:translate-y-0"
        href={`#${mainId}`}
      >
        {skipLabel}
      </a>
      <header
        className={cx(
          "flex flex-wrap items-center justify-between gap-x-6 border-b border-divider max-sm:gap-x-3",
          navigation ? "min-h-18" : "min-h-22 py-3 max-sm:min-h-19",
        )}
      >
        <p
          className={cx(
            "py-3 font-display font-semibold tracking-[0.035em] uppercase max-sm:max-w-44",
            navigation ? "text-wordmark max-sm:text-label" : "text-body max-sm:text-caption",
          )}
        >
          <span className="inline-block">{t("app.brand")}</span>{" "}
          <span className="inline-block text-accent">{t("app.arena")}</span>
        </p>
        {navigation ? (
          <nav
            className="order-3 flex max-w-full basis-full flex-wrap gap-x-6 self-stretch md:order-none md:mr-auto md:ml-8 md:basis-auto"
            aria-label={t("app.navigation")}
          >
            {navigation}
          </nav>
        ) : null}
        <div className="max-w-full min-w-0 py-3 text-right text-label text-text-muted">
          {context}
        </div>
      </header>
      <main id={mainId} tabIndex={-1}>
        {children}
      </main>
      <footer className="pt-8 text-center text-caption text-text-muted">
        {footer}
        <nav
          className="mt-2 flex flex-wrap justify-center gap-x-6"
          aria-label={t("legal.navigation")}
        >
          {(["privacy", "terms"] as const).map((page) => (
            <a
              key={page}
              className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-text"
              href={`${import.meta.env.BASE_URL}${page}.html`}
              target="_blank"
              rel="noreferrer"
            >
              {t(`legal.${page}`)}
            </a>
          ))}
          <a
            className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-text"
            href={`${import.meta.env.BASE_URL}licensing.html`}
            target="_blank"
            rel="noreferrer"
          >
            {t("licensing.link")}
          </a>
        </nav>
      </footer>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}
