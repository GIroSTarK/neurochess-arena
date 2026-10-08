import { cx } from "./cx";

const sizes = { xs: "size-3", sm: "size-4", md: "size-5" } as const;

export function Icon({
  path,
  className,
  size = "md",
}: {
  readonly path: string;
  readonly className?: string;
  readonly size?: keyof typeof sizes;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cx("shrink-0 fill-none stroke-current stroke-2", sizes[size], className)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} />
    </svg>
  );
}
