import type { ComponentProps } from "react";

import { cx } from "./cx";
import { cancelHeldActivation } from "./keyboard";

export type ButtonVariant = "primary" | "secondary" | "danger";

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
};

export interface ButtonProps extends ComponentProps<"button"> {
  readonly variant: ButtonVariant;
}

/**
 * Use `aria-disabled` to preserve focus and tab order; this control guards activation.
 * A held Enter or Space activates once per press.
 */
export function Button({
  variant,
  className,
  type = "button",
  "aria-disabled": ariaDisabled,
  onClick,
  onKeyDown,
  ...props
}: ButtonProps) {
  const unavailable = ariaDisabled === true || ariaDisabled === "true";
  return (
    <button
      type={type}
      className={cx(
        "inline-flex min-h-target max-w-full items-center justify-center gap-2 rounded-control border px-4 py-2 text-center text-label font-semibold",
        "motion-safe:transition-[box-shadow,background-color] motion-safe:duration-120 motion-safe:ease-arena",
        "disabled:border-control-border disabled:bg-surface-raised disabled:text-text-secondary",
        "aria-disabled:border-control-border aria-disabled:bg-surface-raised aria-disabled:text-text-secondary",
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
