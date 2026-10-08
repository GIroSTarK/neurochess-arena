import type { ComponentProps } from "react";
import { Link } from "react-router";

import { cx } from "./cx";

export function TextLink({
  inline = false,
  className,
  ...props
}: ComponentProps<typeof Link> & { readonly inline?: boolean }) {
  return (
    <Link
      className={cx(
        "text-accent underline",
        !inline && "inline-flex min-h-target items-center",
        className,
      )}
      {...props}
    />
  );
}
