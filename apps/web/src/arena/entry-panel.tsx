import { type ReactNode, useId } from "react";

export function EntryPanel({
  title,
  description,
  compactDescription,
  action,
}: {
  readonly title: string;
  readonly description: string;
  readonly compactDescription: string;
  readonly action: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="grid gap-6">
      <h2
        id={headingId}
        className="relative border-b border-divider pb-4 text-section font-semibold after:absolute after:bottom-0 after:left-0 after:h-0.5 after:w-18 after:bg-accent @max-arena-wide/arena:sr-only"
      >
        {title}
      </h2>
      <p className="hidden text-body text-text-secondary @arena-wide/arena:block">{description}</p>
      <p className="text-body text-text-secondary @arena-wide/arena:hidden">{compactDescription}</p>
      {action}
    </section>
  );
}
