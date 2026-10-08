import type { ComponentProps } from "react";

import { cx } from "./cx";
import { Icon } from "./icon";

export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <span className="relative block w-full min-w-0">
      <select
        {...props}
        className={cx(
          "min-h-target w-full min-w-0 appearance-none rounded-control border border-control-border bg-surface py-2 ps-3 pe-10 text-body text-text aria-invalid:border-danger",
          className,
        )}
      >
        {children}
      </select>
      <Icon
        path="m6 9 6 6 6-6"
        size="sm"
        className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-text-secondary"
      />
    </span>
  );
}
