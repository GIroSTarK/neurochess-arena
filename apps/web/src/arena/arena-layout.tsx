import type { ChessColor } from "@neurochess/contracts";
import type { ReactNode } from "react";

import { cx } from "../ui/cx";

import { PlayerSummary, type PlayerSummaryData } from "./panels/player-summary";

export function ArenaLayout({
  players,
  board,
  details,
  playAreaLabel,
  detailsLabel,
  introduction,
  boardTools,
  constrainDetails = false,
}: {
  readonly players: Readonly<Record<ChessColor, PlayerSummaryData>>;
  readonly board: ReactNode;
  readonly details: ReactNode;
  readonly playAreaLabel: string;
  readonly detailsLabel: string;
  readonly introduction?: ReactNode;
  readonly boardTools?: ReactNode;
  readonly constrainDetails?: boolean;
}) {
  // Inspection help may grow below the row that sets the information rail's height.
  const separateToolsRow = Boolean(boardTools) && !introduction;
  return (
    <div
      className={cx(
        "relative mx-auto grid max-w-[1120px] min-w-0 gap-8 lg:chamfer-frame lg:grid-cols-[minmax(0,1fr)_400px] lg:px-8 lg:pt-5 lg:pb-12",
        Boolean(introduction) && "max-lg:gap-4 lg:grid-rows-[auto_1fr] lg:gap-y-0",
        separateToolsRow && "lg:gap-y-0",
      )}
      data-testid="arena-frame"
    >
      {introduction ? (
        <div className="mx-auto w-full max-w-[640px] min-w-0 lg:col-start-2 lg:row-start-1 lg:border-l lg:border-divider lg:pb-8 lg:pl-8">
          {introduction}
        </div>
      ) : null}
      <section
        className={cx(
          "mx-auto flex w-full max-w-[640px] min-w-0 flex-col self-start lg:pr-2 lg:pl-[clamp(0px,calc((100vw-1120px)/4),80px)]",
          Boolean(introduction) && "lg:col-start-1 lg:row-span-2 lg:row-start-1",
          separateToolsRow && "lg:row-span-2 lg:grid lg:grid-rows-subgrid lg:self-stretch",
        )}
        aria-label={playAreaLabel}
      >
        <div className="min-w-0">
          <div className="mb-4 grid grid-cols-2 rounded-panel border border-divider bg-surface">
            <PlayerSummary color="white" {...players.white} />
            <PlayerSummary color="black" {...players.black} />
          </div>
          {board}
        </div>
        {boardTools}
      </section>
      <aside
        className={cx(
          "flex min-h-0 min-w-0 flex-col max-lg:mx-auto max-lg:w-full max-lg:max-w-[640px] lg:border-l lg:border-divider lg:pl-8",
          Boolean(introduction) && "lg:col-start-2 lg:row-start-2",
          separateToolsRow && "lg:col-start-2 lg:row-start-1",
          constrainDetails
            ? "gap-4 lg:[scrollbar-gutter:stable] lg:overflow-y-auto lg:pr-2 lg:pb-2 lg:contain-size"
            : "gap-8",
        )}
        aria-label={detailsLabel}
      >
        {details}
      </aside>
    </div>
  );
}
