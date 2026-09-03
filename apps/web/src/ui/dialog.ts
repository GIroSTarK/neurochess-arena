import { cx } from "./cx";

/**
 * Shared modal presentation: centered on desktop, a scrollable sheet on narrow screens.
 * Preflight zeroes every margin, so `m-auto` restores the native modal centering.
 */
export const dialogClassName = cx(
  "m-auto max-h-[calc(100dvh_-_32px)] w-[min(36rem,calc(100%_-_32px))] overflow-auto rounded-panel border border-control-border bg-surface-raised p-6 text-text",
  "shadow-[0_1rem_4rem_var(--color-canvas)] backdrop:bg-canvas/85 max-sm:p-4",
);

export const dialogTitleClassName = "text-section font-semibold";

export const dialogDescriptionClassName = "mt-3 text-text-secondary";
