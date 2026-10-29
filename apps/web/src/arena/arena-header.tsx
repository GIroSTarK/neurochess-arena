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
    <div className="@container/arena mx-auto max-w-[1120px] min-w-0">
      <div
        className={cx(
          "mx-auto flex max-w-[640px] flex-wrap justify-between gap-x-4 gap-y-2 py-4 @arena-wide/arena:max-w-[1072px] @arena-wide/arena:px-8",
          score ? "items-start @arena-wide/arena:items-center" : "items-center",
        )}
      >
        <div
          className={
            score
              ? "min-w-0 flex-[1_1_16rem] @max-arena-wide/arena:contents"
              : "min-w-0 flex-[1_1_9rem] @max-arena-wide/arena:contents"
          }
        >
          <h1
            className={cx(
              "font-display text-title font-medium @max-arena-wide/arena:min-w-0",
              score
                ? "@max-arena-wide/arena:flex-[1_1_16rem]"
                : "@max-arena-wide/arena:flex-[1_1_9rem]",
            )}
          >
            {title}
          </h1>
          <div className="mt-1 text-text-secondary @max-arena-wide/arena:order-3 @max-arena-wide/arena:mt-0 @max-arena-wide/arena:basis-full">
            {typeof description === "string" ? <p>{description}</p> : description}
          </div>
        </div>
        {score ? (
          <>
            <div className="order-4 min-w-0 basis-full @arena-wide/arena:order-2 @arena-wide/arena:basis-auto">
              {trailing}
            </div>
            <div className="order-2 max-w-full @arena-wide/arena:order-3">{score}</div>
          </>
        ) : (
          trailing
        )}
      </div>
    </div>
  );
}
