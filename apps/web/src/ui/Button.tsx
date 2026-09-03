import type { ComponentProps } from "react";

import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "danger";

// Hover and pressed states add an inset keyline or the neutral surface without
// changing layout. Disabled controls keep a readable label and drop emphasis.
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

export function Button({ variant, className, type = "button", ...props }: ButtonProps) {
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
      {...props}
    />
  );
}
