import type { ReactNode } from "react";

import { cx } from "../ui/cx";

export function ArenaHeader({
  title,
  description,
  trailing,
  variant = "standard",
}: {
  readonly title: string;
  readonly description: ReactNode;
  readonly trailing?: ReactNode;
  readonly variant?: "standard" | "live";
}) {
  return (
    <div
      className={cx(
        "flex items-center justify-between",
        variant === "live"
          ? "mx-auto max-w-[1120px] flex-wrap gap-x-4 gap-y-3 py-6"
          : "gap-6 py-8 max-lg:flex-col max-lg:items-start max-lg:gap-4 max-sm:py-6",
      )}
    >
      <div className={variant === "live" ? "min-w-0 flex-[1_1_9rem]" : undefined}>
        <h1
          className={cx(
            "font-display text-title font-medium",
            variant === "standard" && "max-sm:text-[1.5rem]/8",
          )}
        >
          {title}
        </h1>
        <div className={cx("text-text-secondary", variant === "live" ? "mt-1" : "mt-2")}>
          {typeof description === "string" ? <p>{description}</p> : description}
        </div>
      </div>
      {trailing}
    </div>
  );
}
