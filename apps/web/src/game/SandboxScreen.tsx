import type { ChessColor } from "@neurochess/contracts";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AppShell } from "../app/AppShell";
import { ArenaHeader } from "../arena/ArenaHeader";
import { ArenaLayout } from "../arena/ArenaLayout";
import { BoardTools } from "../arena/BoardTools";
import { EntryPanel } from "../arena/EntryPanel";
import { MoveHistory } from "../arena/panels/MoveHistory";
import { ServiceStatus } from "../arena/ServiceStatus";
import { StatusFeedback } from "../arena/StatusFeedback";
import { StatusSummary } from "../arena/StatusSummary";
import { Chessboard, type ChessboardHandle } from "../board/Chessboard";
import { Icon } from "../ui/Icon";

import { CommandRecovery } from "./panels/CommandRecovery";
import { GameStatus } from "./panels/GameStatus";
import { LifecycleControls } from "./panels/LifecycleControls";
import { PgnActions } from "./panels/PgnActions";
import { ReplayControls } from "./panels/ReplayControls";
import { StartButton } from "./panels/StartButton";
import { sandboxPresentation } from "./presentation";
import { sandboxStatusPresentation } from "./statusPresentation";
import { useSandbox } from "./useSandbox";

export function SandboxScreen({ apiBaseUrl }: { readonly apiBaseUrl: string }) {
  const { t } = useTranslation();
  const helpId = useId();
  const { state, controller } = useSandbox(apiBaseUrl);
  const [orientation, setOrientation] = useState<ChessColor>("white");
  const board = useRef<ChessboardHandle>(null);
  const view = sandboxPresentation(state, t);
  const status = sandboxStatusPresentation(state, t);
  const feedbackVisible =
    (status.feedback !== null &&
      (status.feedback.activeId !== null ||
        status.feedback.notices.some((notice) => notice.visible))) ||
    status.notice !== null ||
    status.followUp !== null;
  const { startedGameId } = view;

  useLayoutEffect(() => {
    if (startedGameId === null) return;
    // Start removes its trigger. Recovery never requests focus, and a later response must not
    // steal it from someone who has already moved to another control.
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) board.current?.focus();
  }, [startedGameId]);

  function flipBoard() {
    setOrientation((previous) => (previous === "white" ? "black" : "white"));
  }

  return (
    <AppShell
      mainId="sandbox"
      skipLabel={t("app.skipLink")}
      context={t("app.localDevelopment")}
      navigation={
        view.live ? (
          <a
            href="#sandbox"
            aria-current="page"
            className="flex min-h-18 items-center border-b-2 border-accent px-1 text-label text-text"
          >
            {t("app.arena")}
          </a>
        ) : undefined
      }
      footer={
        view.live ? (
          <div className="flex flex-col items-center justify-center gap-x-6 gap-y-2 md:flex-row">
            <span>{t("sandbox.sessionFooter")}</span>
            <ServiceStatus state={state.readiness} compact />
          </div>
        ) : (
          t("sandbox.footer")
        )
      }
      announcement={view.announcement}
    >
      <ArenaHeader
        variant={view.live ? "live" : "standard"}
        title={t(view.live ? "sandbox.liveTitle" : "sandbox.title")}
        description={
          view.live ? (
            <StatusSummary {...status} pausedLabel={t("game.pausedTitle")} />
          ) : (
            t("sandbox.description")
          )
        }
        trailing={
          view.live ? (
            <span className="flex max-w-full items-center gap-2 text-label text-text-secondary">
              <Icon path="M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3" />
              {t("sandbox.privacy")}
            </span>
          ) : (
            <ServiceStatus state={state.readiness} />
          )
        }
      />
      <ArenaLayout
        variant={view.live ? "live" : "standard"}
        players={view.players}
        playAreaLabel={t("sandbox.playArea")}
        detailsLabel={t("sandbox.gameDetails")}
        board={
          view.board ? (
            <>
              <Chessboard
                ref={board}
                {...view.board}
                orientation={orientation}
                coordinates={view.live ? "framed" : "inside"}
                onMove={(move) => {
                  void controller.submit(move);
                }}
                describedBy={helpId}
              />
              {view.live ? (
                <LifecycleControls
                  state={state}
                  controller={controller}
                  boardTools={{ orientation, onFlip: flipBoard, helpId }}
                />
              ) : (
                <>
                  {view.terminal ? <ReplayControls state={state} controller={controller} /> : null}
                  <BoardTools orientation={orientation} onFlip={flipBoard} helpId={helpId} />
                </>
              )}
            </>
          ) : (
            <EntryPanel
              title={t("sandbox.entryTitle")}
              description={t("sandbox.entryDescription")}
              action={<StartButton state={state} controller={controller} />}
            />
          )
        }
        details={
          <>
            {!view.live ? <GameStatus state={state} controller={controller} /> : null}
            <MoveHistory
              moves={view.moves}
              variant={view.live ? "rail" : "panel"}
              selectedPly={view.selectedPly}
              onSelect={state.replay ? (ply) => controller.selectPly(ply) : undefined}
            />
            {view.live ? (
              <>
                <div className="border-t border-divider pt-4 text-body text-text-secondary">
                  {/* Guidance and passive feedback reserve one track; recovery actions stay outside hidden content. */}
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)]">
                    <div
                      className="min-w-0 self-start [grid-area:1/1] aria-hidden:invisible"
                      aria-hidden={feedbackVisible}
                    >
                      <p>{t("sandbox.controlHint")}</p>
                      <p className="mt-1">{t("sandbox.moveHint")}</p>
                    </div>
                    <div
                      className="min-w-0 self-start [grid-area:1/1] aria-hidden:invisible"
                      aria-hidden={!feedbackVisible}
                    >
                      <StatusFeedback {...status} />
                    </div>
                  </div>
                  <CommandRecovery state={state} controller={controller} />
                </div>
              </>
            ) : (
              <>
                {view.terminal ? <PgnActions state={state} controller={controller} /> : null}
                <div className="text-label text-text-muted">
                  <span className="flex items-center gap-2 text-text-secondary">
                    <Icon path="M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3" />
                    {t("sandbox.privacy")}
                  </span>
                  <p className="mt-2">{t("sandbox.memoryHint")}</p>
                </div>
              </>
            )}
          </>
        }
      />
    </AppShell>
  );
}
