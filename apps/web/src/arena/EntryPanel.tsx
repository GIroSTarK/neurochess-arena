import type { ReactNode } from "react";

import { PieceIcon } from "../board/PieceIcon";

export function EntryPanel({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description: string;
  readonly action: ReactNode;
}) {
  return (
    <div className="grid aspect-square min-h-[380px] place-items-center border border-divider p-8 checkered-backdrop max-sm:aspect-auto max-sm:min-h-[340px] max-sm:px-4 max-sm:py-6">
      <div className="w-full max-w-[23rem] text-center">
        <div className="mb-6 flex justify-center max-sm:mb-4">
          <PieceIcon color="white" kind="n" className="size-20" />
        </div>
        <h2 className="font-display text-title font-semibold max-sm:text-section">{title}</h2>
        <p className="mt-4 text-text-secondary">{description}</p>
        {action}
      </div>
    </div>
  );
}
