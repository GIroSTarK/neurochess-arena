import type { ReactNode } from "react";

export function ArenaHeader({
  title,
  description,
  trailing,
}: {
  readonly title: string;
  readonly description: string;
  readonly trailing?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-8 max-lg:flex-col max-lg:items-start max-lg:gap-4 max-sm:py-6">
      <div>
        <h1 className="font-display text-title font-medium max-sm:text-[1.5rem]/8">{title}</h1>
        <p className="mt-2 text-text-secondary">{description}</p>
      </div>
      {trailing}
    </div>
  );
}
