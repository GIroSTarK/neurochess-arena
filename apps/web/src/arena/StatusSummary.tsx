import { Icon } from "../ui/Icon";

import type { StatusPresentation } from "./status";

export function StatusSummary({
  title,
  titleVariants,
  pausedLabel,
}: Pick<StatusPresentation, "title" | "titleVariants"> & { readonly pausedLabel: string }) {
  return (
    <h2 className="grid min-w-0 grid-cols-[minmax(0,1fr)] text-label font-normal text-text-secondary">
      {/* Measure the pause marker with its own label so a state change cannot reflow the header. */}
      {[...new Set([...titleVariants, title])].map((label) => (
        <span
          key={label}
          className="flex min-w-0 items-start gap-2 [grid-area:1/1] aria-hidden:invisible"
          aria-hidden={label !== title}
        >
          {label === pausedLabel ? <Icon path="M9 5v14M15 5v14" className="text-warning" /> : null}
          <span className="min-w-0">{label}</span>
        </span>
      ))}
    </h2>
  );
}
