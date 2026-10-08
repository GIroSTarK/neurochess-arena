import { cx } from "./cx";

/** Reserve the largest localized variant without fixing a control's dimensions. */
export function StableText({
  value,
  variants,
  align = "start",
}: {
  readonly value: string;
  readonly variants: readonly string[];
  readonly align?: "start" | "center";
}) {
  return (
    <span className="grid min-w-0 grid-cols-[minmax(0,1fr)]">
      {[...new Set([...variants, value])].map((text) => (
        <span
          key={text}
          aria-hidden={text !== value}
          className={cx(
            "min-w-0 [grid-area:1/1] aria-hidden:invisible",
            align === "center" ? "self-center" : "self-start",
          )}
        >
          {text}
        </span>
      ))}
    </span>
  );
}
