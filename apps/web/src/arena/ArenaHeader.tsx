import type { ReactNode } from "react";

import { cx } from "../ui/cx";

export function ArenaHeader({
  title,
  description,
  trailing,
  variant = "standard",
  score,
}: {
  readonly title: string;
  readonly description: ReactNode;
  readonly trailing?: ReactNode;
  readonly variant?: "standard" | "live";
  readonly score?: ReactNode;
}) {
  return (
    <div
      className={cx(
        "flex justify-between",
        score ? "items-start lg:items-center" : "items-center",
        variant === "live"
          ? "mx-auto max-w-[1120px] flex-wrap gap-x-4 gap-y-3 py-6"
          : "gap-6 py-8 max-lg:flex-col max-lg:items-start max-lg:gap-4 max-sm:py-6",
      )}
    >
      <div
        className={
          score
            ? "min-w-0 flex-[1_1_16rem] max-lg:contents"
            : variant === "live"
              ? "min-w-0 flex-[1_1_9rem] max-lg:contents"
              : undefined
        }
      >
        <h1
          className={cx(
            "font-display text-title font-medium",
            variant === "standard" && "max-sm:text-[1.5rem]/8",
            variant === "live" && "max-lg:min-w-0",
            variant === "live" && (score ? "max-lg:flex-[1_1_16rem]" : "max-lg:flex-[1_1_9rem]"),
          )}
        >
          {title}
        </h1>
        <div
          className={cx(
            "text-text-secondary",
            variant === "live" ? "mt-1 max-lg:order-3 max-lg:mt-0 max-lg:basis-full" : "mt-2",
          )}
        >
          {typeof description === "string" ? <p>{description}</p> : description}
        </div>
      </div>
      {score ? (
        <>
          <div className="order-4 min-w-0 basis-full lg:order-2 lg:basis-auto">{trailing}</div>
          <div className="order-2 max-w-full lg:order-3">{score}</div>
        </>
      ) : (
        trailing
      )}
    </div>
  );
}
