import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface AppShellProps {
  readonly mainId: string;
  readonly skipLabel: string;
  readonly context: ReactNode;
  readonly footer: ReactNode;
  readonly announcement: string;
  readonly children: ReactNode;
}

export function AppShell({
  mainId,
  skipLabel,
  context,
  footer,
  announcement,
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
      <header className="flex min-h-22 flex-wrap items-center justify-between gap-6 border-b border-divider py-3 max-sm:min-h-19 max-sm:gap-3">
        <p className="font-display text-body font-semibold tracking-[0.035em] uppercase max-sm:max-w-44 max-sm:text-caption">
          <span className="inline-block">{t("app.brand")}</span>{" "}
          <span className="inline-block text-accent">{t("app.arena")}</span>
        </p>
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
