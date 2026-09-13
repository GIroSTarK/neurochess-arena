import type { ChessColor } from "@neurochess/contracts";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AppNavigation } from "../app/AppNavigation";
import { AppShell } from "../app/AppShell";
import { ArenaDetails } from "../arena/ArenaDetails";
import { ArenaHeader } from "../arena/ArenaHeader";
import { ArenaLayout } from "../arena/ArenaLayout";
import { BoardTools } from "../arena/BoardTools";
import { EntryPanel } from "../arena/EntryPanel";
import { MoveHistory } from "../arena/panels/MoveHistory";
import { RecoveryNotice } from "../arena/RecoveryNotice";
import { ServiceStatus } from "../arena/ServiceStatus";
import { StatusFeedback } from "../arena/StatusFeedback";
import { StatusSummary } from "../arena/StatusSummary";
import { Chessboard, type ChessboardHandle } from "../board/Chessboard";
import { standardPositionPreview } from "../position/preview";
import { cx } from "../ui/cx";
import { Icon } from "../ui/Icon";

import { CommandRecovery } from "./panels/CommandRecovery";
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
  const feedback = {
    ...status,
    feedback: status.feedback
      ? {
          ...status.feedback,
          notices: status.feedback.notices.map((notice) => ({
            ...notice,
            visible:
              notice.visible &&
              !(view.recovery && (notice.id === "recovered" || notice.id === "existing")),
          })),
        }
      : null,
  };
  const feedbackVisible =
    (feedback.feedback !== null &&
      (feedback.feedback.activeId !== null ||
        feedback.feedback.notices.some((notice) => notice.visible))) ||
    feedback.notice !== null ||
    feedback.followUp !== null;
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
      skipLabel={t("sandbox.skipLink")}
      context={t("app.localDevelopment")}
      navigation={<AppNavigation page="sandbox" sandboxEnabled />}
      footer={
        <div className="flex flex-col items-center justify-center gap-x-6 gap-y-2 md:flex-row">
          <span>{t(view.board ? "sandbox.sessionFooter" : "sandbox.footer")}</span>
          <ServiceStatus state={state.readiness} compact />
        </div>
      }
      announcement={view.announcement}
    >
      <ArenaHeader
        variant="live"
        title={view.result?.title ?? t("sandbox.title")}
        description={
          view.result ? (
            view.result.description
          ) : view.live ? (
            <StatusSummary
              {...status}
              pausedLabels={(["white", "black"] as const).map((color) =>
                t("game.pausedTurn", { color: t(`players.${color}`) }),
              )}
            />
          ) : (
            t("sandbox.description")
          )
        }
        trailing={
          <span
            className={cx(
              "max-w-full items-center gap-2 text-label text-text-secondary",
              view.board ? "flex" : "hidden lg:flex",
            )}
          >
            <Icon path="M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3" />
            {t("sandbox.privacy")}
          </span>
        }
        score={
          view.result ? (
            <span
              data-testid="game-score"
              className="inline-block rounded-control border border-control-border px-3 py-2 font-display text-title text-text"
            >
              <span className="sr-only">{view.result.scoreLabel}</span>
              <span aria-hidden="true">{view.result.score}</span>
            </span>
          ) : undefined
        }
      />
      <ArenaLayout
        variant="live"
        players={view.players}
        playAreaLabel={t("sandbox.playArea")}
        detailsLabel={t("sandbox.gameDetails")}
        introduction={
          !view.board ? (
            <>
              <EntryPanel
                title={t("sandbox.entryTitle")}
                description={t("sandbox.entryDescription")}
                compactDescription={t("sandbox.entryCompactDescription")}
                action={<StartButton state={state} controller={controller} />}
              />
              <StatusFeedback {...status} />
              <CommandRecovery state={state} controller={controller} />
            </>
          ) : undefined
        }
        board={
          <>
            <Chessboard
              ref={board}
              {...(view.board ?? {
                canMove: false,
                view: standardPositionPreview,
                interactionEpoch: "preview",
              })}
              orientation={view.board ? orientation : "white"}
              coordinates="framed"
              onMove={(move) => {
                void controller.submit(move);
              }}
              describedBy={helpId}
            />
            {!view.board ? (
              <>
                <p className="mt-4 text-label text-text-secondary">{t("sandbox.preview")}</p>
                <p id={helpId} className="sr-only">
                  {t("board.instructions")}
                </p>
              </>
            ) : view.live ? (
              <>
                {view.recovery ? (
                  <div className="mt-4 lg:hidden">
                    <RecoveryNotice {...view.recovery} />
                  </div>
                ) : null}
                <LifecycleControls
                  state={state}
                  controller={controller}
                  boardTools={{ orientation, onFlip: flipBoard, helpId }}
                />
              </>
            ) : (
              <>
                {view.terminal ? (
                  <>
                    <ReplayControls state={state} controller={controller} />
                    <PgnActions state={state} controller={controller} />
                  </>
                ) : null}
                <BoardTools orientation={orientation} onFlip={flipBoard} helpId={helpId} />
              </>
            )}
          </>
        }
        details={
          view.board ? (
            <ArenaDetails
              moves={
                <MoveHistory
                  moves={view.moves}
                  variant="rail"
                  selectedPly={view.selectedPly}
                  onSelect={state.replay ? (ply) => controller.selectPly(ply) : undefined}
                />
              }
            >
              <div className="shrink-0 border-t border-divider pt-4 text-body text-text-secondary">
                {view.terminal ? (
                  <>
                    <StartButton state={state} controller={controller} />
                    <p className="mt-6">{t("replay.hint")}</p>
                    <StatusFeedback {...status} />
                  </>
                ) : (
                  <>
                    {view.recovery ? (
                      <div className="hidden lg:block">
                        <RecoveryNotice {...view.recovery} />
                      </div>
                    ) : null}
                    <div
                      className={
                        view.recovery && !feedbackVisible
                          ? "hidden"
                          : "grid min-w-0 grid-cols-[minmax(0,1fr)]"
                      }
                    >
                      <div
                        className="min-w-0 self-start [grid-area:1/1] aria-hidden:invisible"
                        aria-hidden={feedbackVisible || view.recovery !== null}
                      >
                        <p>{t("sandbox.controlHint")}</p>
                        <p className="mt-1">{t("sandbox.moveHint")}</p>
                      </div>
                      <div
                        className="min-w-0 self-start [grid-area:1/1] aria-hidden:invisible"
                        aria-hidden={!feedbackVisible}
                      >
                        <StatusFeedback {...feedback} />
                      </div>
                    </div>
                  </>
                )}
                <CommandRecovery state={state} controller={controller} />
              </div>
            </ArenaDetails>
          ) : (
            <div className="flex items-start gap-3 border-t border-divider pt-6 text-label text-text-secondary">
              <Icon path="M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3" />
              <div>
                <p>{t("sandbox.sessionHint")}</p>
                <p className="mt-1">{t("sandbox.reopenHint")}</p>
              </div>
            </div>
          )
        }
      />
    </AppShell>
  );
}
