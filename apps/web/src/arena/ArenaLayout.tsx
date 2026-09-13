import type { ChessColor } from "@neurochess/contracts";
import type { ReactNode } from "react";

import { cx } from "../ui/cx";

import { PlayerSummary, type PlayerSummaryData } from "./panels/PlayerSummary";

export function ArenaLayout({
  players,
  board,
  details,
  playAreaLabel,
  detailsLabel,
  variant = "standard",
  introduction,
}: {
  readonly players: Readonly<Record<ChessColor, PlayerSummaryData>>;
  readonly board: ReactNode;
  readonly details: ReactNode;
  readonly playAreaLabel: string;
  readonly detailsLabel: string;
  readonly variant?: "standard" | "live";
  readonly introduction?: ReactNode;
}) {
  return (
    <div
      className={cx(
        "relative grid min-w-0 gap-8 lg:chamfer-frame",
        variant === "live"
          ? "mx-auto max-w-[1120px] lg:grid-cols-[minmax(0,1fr)_400px] lg:px-8 lg:pt-5 lg:pb-12"
          : "lg:grid-cols-[minmax(0,1fr)_minmax(320px,384px)] lg:p-8",
        Boolean(introduction) && "max-lg:gap-4 lg:grid-rows-[auto_1fr] lg:gap-y-0",
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
          "mx-auto flex w-full max-w-[640px] min-w-0 flex-col self-start",
          variant === "live" && "lg:pr-2 lg:pl-[clamp(0px,calc((100vw-1120px)/4),80px)]",
          Boolean(introduction) && "lg:col-start-1 lg:row-span-2 lg:row-start-1",
        )}
        aria-label={playAreaLabel}
      >
        <div className="mb-4 grid grid-cols-2 rounded-panel border border-divider bg-surface">
          <PlayerSummary color="white" {...players.white} compact={variant === "live"} />
          <PlayerSummary color="black" {...players.black} compact={variant === "live"} />
        </div>
        {board}
      </section>
      <aside
        className={cx(
          "flex min-h-0 min-w-0 flex-col gap-8 max-lg:mx-auto max-lg:w-full max-lg:max-w-[640px]",
          variant === "live" && "lg:border-l lg:border-divider lg:pl-8",
          Boolean(introduction) && "lg:col-start-2 lg:row-start-2",
        )}
        aria-label={detailsLabel}
      >
        {details}
      </aside>
    </div>
  );
}
