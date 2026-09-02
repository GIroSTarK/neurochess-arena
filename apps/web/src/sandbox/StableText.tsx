/** Reserve the largest localized variant without fixing a control's dimensions. */
export function StableText({
  value,
  variants,
}: {
  readonly value: string;
  readonly variants: readonly string[];
}) {
  return (
    <span className="stable-text">
      {[...new Set([...variants, value])].map((text) => (
        <span key={text} aria-hidden={text !== value}>
          {text}
        </span>
      ))}
    </span>
  );
}
