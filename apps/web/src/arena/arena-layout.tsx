import type { ChessColor } from "@neurochess/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { cx } from "../ui/cx";

import { ArenaLayoutContext, type ArenaLayoutMode } from "./layout-mode";
import { PlayerSummary, type PlayerSummaryData } from "./panels/player-summary";

export function ArenaLayout({
  players,
  board,
  details,
  playAreaLabel,
  detailsLabel,
  introduction,
  notice,
  boardTools,
  constrainDetails = false,
}: {
  readonly players: Readonly<Record<ChessColor, PlayerSummaryData>>;
  readonly board: ReactNode;
  readonly details: ReactNode;
  readonly playAreaLabel: string;
  readonly detailsLabel: string;
  readonly introduction?: ReactNode;
  readonly notice?: ReactNode;
  readonly boardTools?: ReactNode;
  readonly constrainDetails?: boolean;
}) {
  const markerRef = useRef<HTMLSpanElement>(null);
  const [mode, setMode] = useState<ArenaLayoutMode>("stacked");

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker || typeof ResizeObserver === "undefined") return;
    // The marker changes size in the same container query as the columns, including on text zoom.
    const observer = new ResizeObserver(() => {
      setMode(
        getComputedStyle(marker).getPropertyValue("--arena-layout").trim() === "wide"
          ? "wide"
          : "stacked",
      );
    });
    observer.observe(marker);
    return () => observer.disconnect();
  }, []);

  // Inspection help may grow below the row that sets the information rail's height.
  const separateToolsRow = Boolean(boardTools) && !introduction;
  return (
    <ArenaLayoutContext value={mode}>
      <div
        className="@container/arena mx-auto max-w-[1120px] min-w-0"
        data-testid="arena-container"
      >
        <div
          className={cx(
            "relative mx-auto grid max-w-[1040px] min-w-0 gap-6 @arena-wide/arena:chamfer-frame @arena-wide/arena:grid-cols-[640px_minmax(0,1fr)] @arena-wide/arena:px-4 @arena-wide/arena:pt-4 @arena-wide/arena:pb-8",
            Boolean(introduction) &&
              "@max-arena-wide/arena:gap-4 @arena-wide/arena:grid-rows-[auto_1fr] @arena-wide/arena:gap-y-0",
            separateToolsRow && "@arena-wide/arena:gap-y-0",
          )}
          data-testid="arena-frame"
        >
          <span
            ref={markerRef}
            aria-hidden="true"
            className="pointer-events-none absolute h-0 w-0 [--arena-layout:stacked] @arena-wide/arena:w-px @arena-wide/arena:[--arena-layout:wide]"
          />
          {introduction ? (
            <div className="mx-auto w-full max-w-[640px] min-w-0 @arena-wide/arena:col-start-2 @arena-wide/arena:row-start-1 @arena-wide/arena:border-l @arena-wide/arena:border-divider @arena-wide/arena:pb-6 @arena-wide/arena:pl-4">
              {introduction}
            </div>
          ) : null}
          <section
            className={cx(
              "mx-auto flex w-full max-w-[640px] min-w-0 flex-col self-start",
              Boolean(introduction) &&
                "@arena-wide/arena:col-start-1 @arena-wide/arena:row-span-2 @arena-wide/arena:row-start-1",
              separateToolsRow &&
                "@arena-wide/arena:row-span-2 @arena-wide/arena:grid @arena-wide/arena:grid-rows-subgrid @arena-wide/arena:self-stretch",
            )}
            aria-label={playAreaLabel}
          >
            <div className="min-w-0">
              <div className="mb-4 grid grid-cols-2 rounded-panel border border-divider bg-surface">
                <PlayerSummary color="white" {...players.white} />
                <PlayerSummary color="black" {...players.black} />
              </div>
              {notice ? <div className="mb-4 min-w-0">{notice}</div> : null}
              {board}
            </div>
            {boardTools}
          </section>
          <aside
            className={cx(
              "flex min-h-0 min-w-0 flex-col @max-arena-wide/arena:mx-auto @max-arena-wide/arena:w-full @max-arena-wide/arena:max-w-[640px] @arena-wide/arena:border-l @arena-wide/arena:border-divider @arena-wide/arena:pl-4",
              Boolean(introduction) &&
                "@arena-wide/arena:col-start-2 @arena-wide/arena:row-start-2",
              separateToolsRow && "@arena-wide/arena:col-start-2 @arena-wide/arena:row-start-1",
              constrainDetails
                ? "gap-4 @arena-wide/arena:[scrollbar-gutter:stable] @arena-wide/arena:overflow-y-auto @arena-wide/arena:pr-2 @arena-wide/arena:pb-2 @arena-wide/arena:contain-size"
                : "gap-6",
            )}
            aria-label={detailsLabel}
          >
            {details}
          </aside>
        </div>
      </div>
    </ArenaLayoutContext>
  );
}
