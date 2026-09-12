import type { ChessColor } from "@neurochess/contracts";
import type { ReactNode } from "react";

import { PlayerSummary, type PlayerSummaryData } from "./panels/PlayerSummary";

export function ArenaLayout({
  players,
  board,
  details,
  playAreaLabel,
  detailsLabel,
}: {
  readonly players: Readonly<Record<ChessColor, PlayerSummaryData>>;
  readonly board: ReactNode;
  readonly details: ReactNode;
  readonly playAreaLabel: string;
  readonly detailsLabel: string;
}) {
  return (
    <div
      className="relative grid min-w-0 gap-8 lg:chamfer-frame lg:grid-cols-[minmax(0,1fr)_minmax(320px,384px)] lg:p-8"
      data-testid="arena-frame"
    >
      <section
        className="mx-auto flex w-full max-w-[640px] min-w-0 flex-col self-start"
        aria-label={playAreaLabel}
      >
        <div className="mb-4 grid grid-cols-2 rounded-panel border border-divider bg-surface">
          <PlayerSummary color="white" {...players.white} />
          <PlayerSummary color="black" {...players.black} />
        </div>
        {board}
      </section>
      <aside
        className="flex min-w-0 flex-col gap-8 max-lg:mx-auto max-lg:w-full max-lg:max-w-[640px]"
        aria-label={detailsLabel}
      >
        {details}
      </aside>
    </div>
  );
}
