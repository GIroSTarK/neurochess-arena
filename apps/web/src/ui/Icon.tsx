import { cx } from "./cx";

/** Outline icon with the shared 1.25rem optical size and 2px round stroke. */
export function Icon({ path, className }: { readonly path: string; readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cx("size-5 shrink-0 fill-none stroke-current stroke-2", className)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} />
    </svg>
  );
}
