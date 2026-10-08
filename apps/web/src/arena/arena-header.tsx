import type { ReactNode } from "react";

import { cx } from "../ui/cx";

export function ArenaHeader({
  title,
  description,
  trailing,
  score,
}: {
  readonly title: string;
  readonly description: ReactNode;
  readonly trailing?: ReactNode;
  readonly score?: ReactNode;
}) {
  return (
    <div
      className={cx(
        "mx-auto flex max-w-[1120px] flex-wrap justify-between gap-x-4 gap-y-3 py-6",
        score ? "items-start lg:items-center" : "items-center",
      )}
    >
      <div
        className={
          score
            ? "min-w-0 flex-[1_1_16rem] max-lg:contents"
            : "min-w-0 flex-[1_1_9rem] max-lg:contents"
        }
      >
        <h1
          className={cx(
            "font-display text-title font-medium max-lg:min-w-0",
            score ? "max-lg:flex-[1_1_16rem]" : "max-lg:flex-[1_1_9rem]",
          )}
        >
          {title}
        </h1>
        <div className="mt-1 text-text-secondary max-lg:order-3 max-lg:mt-0 max-lg:basis-full">
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
