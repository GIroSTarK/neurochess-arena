import type { ReactNode, Ref } from "react";

import { cx } from "../ui/cx";

export type PageWidth = "form" | "content" | "wide";

const widths: Record<PageWidth, string> = {
  form: "max-w-xl",
  content: "max-w-3xl",
  wide: "max-w-[70rem]",
};

export function PageLayout({
  title,
  description,
  actions,
  width = "form",
  headingRef,
  children,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly width?: PageWidth;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly children: ReactNode;
}) {
  return (
    <section
      className={cx(
        "@container/page mx-auto grid w-full min-w-0 gap-6 py-6 md:gap-8 md:py-8",
        widths[width],
      )}
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-4 border-b border-divider pb-6">
        <div className="grid min-w-0 flex-[1_1_20rem] gap-2">
          <h1 ref={headingRef} tabIndex={-1} className="font-display text-title font-medium">
            {title}
          </h1>
          {description ? (
            <div className="max-w-[48rem] text-body text-text-secondary">{description}</div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex max-w-full flex-wrap items-center gap-3">{actions}</div>
        ) : null}
      </header>
      {children}
    </section>
  );
}
