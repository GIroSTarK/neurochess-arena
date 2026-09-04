import type { ChessColor } from "@neurochess/contracts";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { BoardKeyboardHelp } from "../board/BoardKeyboardHelp";
import { Chessboard, type ChessboardHandle } from "../board/Chessboard";
import { PieceIcon } from "../board/PieceIcon";
import { replayView } from "../chess/replay";
import { interactionEpoch, isTerminal, type SandboxState } from "../game/controller";
import { GameStatus } from "../game/GameStatus";
import { MoveHistory } from "../game/MoveHistory";
import { PgnActions } from "../game/PgnActions";
import { PlayerSummary } from "../game/PlayerSummary";
import { ReplayControls } from "../game/ReplayControls";
import { StartButton } from "../game/StartButton";
import { useSandbox } from "../game/use-sandbox";
import { announcementMessage } from "../i18n/messages";
import { Button } from "../ui/Button";
import { cx } from "../ui/cx";
import { Icon } from "../ui/Icon";

import { DocumentMetadata } from "./DocumentMetadata";

export interface AppProps {
  readonly apiBaseUrl: string;
}

const connectionMarks: Record<SandboxState["readiness"], string> = {
  checking: "",
  ready: "text-success",
  unavailable: "text-warning",
};

export function App({ apiBaseUrl }: AppProps) {
  const { t } = useTranslation();
  const helpId = useId();
  const { state, controller } = useSandbox(apiBaseUrl);
  const [orientation, setOrientation] = useState<ChessColor>("white");
  const board = useRef<ChessboardHandle>(null);
  const { snapshot } = state;
  const startedGameId =
    state.announcement?.kind === "started" ? state.announcement.snapshot.gameId : null;

  useLayoutEffect(() => {
    if (startedGameId === null) return;
    // An accepted Start or New game removes the control that was activated. Land on the board
    // unless the user has moved elsewhere. Recovery never announces "started", so opening a page
    // cannot take focus.
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) board.current?.focus();
  }, [startedGameId]);

  return (
    <div className="mx-auto w-[min(1280px,calc(100%_-_2rem))] pb-[max(1.5rem,env(safe-area-inset-bottom))] md:w-[min(1280px,calc(100%_-_3rem))] lg:w-[min(1280px,calc(100%_-_4rem))]">
      <DocumentMetadata />
      <a
        className="fixed top-3 left-4 z-10 -translate-y-[200%] rounded-control bg-accent p-3 text-on-accent focus:translate-y-0"
        href="#sandbox"
      >
        {t("app.skipLink")}
      </a>
      <header className="flex min-h-22 flex-wrap items-center justify-between gap-6 border-b border-divider py-3 max-sm:min-h-19 max-sm:gap-3">
        <p className="font-display text-body font-semibold tracking-[0.035em] uppercase max-sm:max-w-44 max-sm:text-caption">
          <span className="inline-block">{t("app.brand")}</span>{" "}
          <span className="inline-block text-accent">{t("app.arena")}</span>
        </p>
        <span className="text-right text-label text-text-muted max-sm:max-w-32 max-sm:text-caption">
          {t("app.localDevelopment")}
        </span>
      </header>
      <main id="sandbox" tabIndex={-1}>
        <div className="flex items-center justify-between gap-6 py-8 max-lg:flex-col max-lg:items-start max-lg:gap-4 max-sm:py-6">
          <div>
            <h1 className="font-display text-title font-medium max-sm:text-[1.5rem]/8">
              {t("sandbox.title")}
            </h1>
            <p className="mt-2 text-text-secondary">{t("sandbox.description")}</p>
          </div>
          <div
            className="flex shrink-0 items-center gap-2 text-label text-text-secondary"
            aria-label={t("connection.label")}
          >
            <span
              className={cx(
                "inline-grid size-5 shrink-0 place-items-center rounded-full border border-current font-semibold",
                connectionMarks[state.readiness],
              )}
              aria-hidden="true"
            >
              {state.readiness === "ready" ? "✓" : state.readiness === "checking" ? "…" : "!"}
            </span>
            <span>{t(`connection.${state.readiness}`)}</span>
          </div>
        </div>
        <div
          className="relative grid min-w-0 gap-8 lg:chamfer-frame lg:grid-cols-[minmax(0,1fr)_minmax(320px,384px)] lg:p-8"
          data-testid="arena-frame"
        >
          <section
            className="mx-auto flex w-full max-w-[640px] min-w-0 flex-col self-start"
            aria-label={t("board.label")}
          >
            <div className="mb-4 grid grid-cols-2 rounded-panel border border-divider bg-surface">
              <PlayerSummary color="white" snapshot={snapshot} />
              <PlayerSummary color="black" snapshot={snapshot} />
            </div>
            {snapshot ? (
              <>
                <Chessboard
                  ref={board}
                  snapshot={snapshot}
                  orientation={orientation}
                  canMove={state.phase === "ready"}
                  interactionEpoch={interactionEpoch(state)}
                  onMove={(move) => {
                    void controller.submit(move);
                  }}
                  view={state.replay ? replayView(state.replay, state.replayPly) : undefined}
                  describedBy={helpId}
                />
                {isTerminal(snapshot) ? (
                  <ReplayControls state={state} controller={controller} />
                ) : null}
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <Button
                    variant="secondary"
                    className="flex-auto"
                    onClick={() =>
                      setOrientation((previous) => (previous === "white" ? "black" : "white"))
                    }
                  >
                    <Icon path="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4" />
                    {t("actions.flip")}
                  </Button>
                  <span className="text-right text-label text-text-secondary">
                    {t(orientation === "white" ? "board.whiteBottom" : "board.blackBottom")}
                  </span>
                </div>
                <BoardKeyboardHelp id={helpId} />
              </>
            ) : (
              <div className="grid aspect-square min-h-[380px] place-items-center border border-divider p-8 checkered-backdrop max-sm:aspect-auto max-sm:min-h-[340px] max-sm:px-4 max-sm:py-6">
                <div className="w-full max-w-[23rem] text-center">
                  <div className="mb-6 flex justify-center max-sm:mb-4">
                    <PieceIcon color="white" kind="n" className="size-20" />
                  </div>
                  <h2 className="font-display text-title font-semibold max-sm:text-section">
                    {t("sandbox.entryTitle")}
                  </h2>
                  <p className="mt-4 text-text-secondary">{t("sandbox.entryDescription")}</p>
                  <StartButton state={state} controller={controller} />
                </div>
              </div>
            )}
          </section>
          <aside
            className="flex min-w-0 flex-col gap-8 max-lg:mx-auto max-lg:w-full max-lg:max-w-[640px]"
            aria-label={t("game.status")}
          >
            <GameStatus state={state} controller={controller} />
            <MoveHistory
              moves={snapshot?.moves ?? []}
              selectedPly={state.replay ? state.replayPly : undefined}
              onSelect={state.replay ? (ply) => controller.selectPly(ply) : undefined}
            />
            {snapshot && isTerminal(snapshot) ? (
              <PgnActions state={state} controller={controller} />
            ) : null}
            <div className="text-label text-text-muted">
              <span className="flex items-center gap-2 text-text-secondary">
                <Icon path="M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3" />
                {t("sandbox.privacy")}
              </span>
              <p className="mt-2">{t("sandbox.memoryHint")}</p>
            </div>
          </aside>
        </div>
      </main>
      <footer className="pt-8 text-center text-caption text-text-muted">
        {t("sandbox.footer")}
      </footer>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcementMessage(state.announcement, t)}
      </div>
    </div>
  );
}
