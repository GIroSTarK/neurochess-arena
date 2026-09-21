import type { ComponentProps } from "react";

import { cx } from "./cx";
import { cancelHeldActivation } from "./keyboard";

export type ButtonVariant =
  "primary" | "secondary" | "danger" | "quiet" | "quiet-danger" | "dismiss";

const variants: Record<ButtonVariant, string> = {
  primary: cx(
    "border-accent bg-accent text-on-accent",
    "hover:not-disabled:not-aria-disabled:shadow-[inset_0_0_0_2px_var(--color-on-accent)]",
    "active:not-disabled:not-aria-disabled:shadow-[inset_0_0_0_2px_var(--color-on-accent)]",
  ),
  secondary: cx(
    "border-control-border bg-surface text-text",
    "hover:not-disabled:not-aria-disabled:bg-surface-raised",
  ),
  danger: "border-danger bg-surface text-text",
  quiet:
    "border-transparent bg-transparent text-text-secondary hover:not-disabled:not-aria-disabled:bg-surface-raised",
  "quiet-danger":
    "border-transparent bg-transparent text-danger hover:not-disabled:not-aria-disabled:bg-surface-raised",
  dismiss:
    "border-transparent bg-transparent text-text-secondary hover:not-disabled:not-aria-disabled:bg-surface hover:not-disabled:not-aria-disabled:text-text active:not-disabled:not-aria-disabled:bg-surface",
};

export interface ButtonProps extends ComponentProps<"button"> {
  readonly variant: ButtonVariant;
  readonly padding?: "normal" | "compact";
}

/**
 * Use `aria-disabled` to preserve focus and tab order; this control guards activation.
 * A held Enter or Space activates once per press.
 */
export function Button({
  variant,
  padding = "normal",
  className,
  type = "button",
  "aria-disabled": ariaDisabled,
  onClick,
  onKeyDown,
  ...props
}: ButtonProps) {
  const unavailable = ariaDisabled === true || ariaDisabled === "true";
  const quiet = variant === "quiet" || variant === "quiet-danger" || variant === "dismiss";
  return (
    <button
      type={type}
      className={cx(
        "inline-flex min-h-target max-w-full items-center justify-center rounded-control border py-2 text-center text-label font-semibold",
        padding === "compact"
          ? "gap-1.5 px-2 max-sm:px-[min(0.5rem,8px)]"
          : "gap-2 px-4 max-sm:px-[min(1rem,16px)]",
        "motion-safe:transition-[box-shadow,background-color] motion-safe:duration-120 motion-safe:ease-arena",
        quiet
          ? "disabled:text-text-muted aria-disabled:text-text-muted"
          : "disabled:border-control-border disabled:bg-surface-raised disabled:text-text-secondary aria-disabled:border-control-border aria-disabled:bg-surface-raised aria-disabled:text-text-secondary",
        variants[variant],
        className,
      )}
      aria-disabled={ariaDisabled}
      onClick={(event) => {
        if (unavailable) event.preventDefault();
        else onClick?.(event);
      }}
      onKeyDown={(event) => {
        if (cancelHeldActivation(event)) return;
        onKeyDown?.(event);
      }}
      {...props}
    />
  );
}
