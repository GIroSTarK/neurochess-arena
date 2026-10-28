import type { ChessColor } from "@neurochess/contracts";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ArenaDetails } from "../arena/arena-details";
import { ArenaHeader } from "../arena/arena-header";
import { ArenaLayout } from "../arena/arena-layout";
import { BoardTools } from "../arena/board-tools";
import { EntryPanel } from "../arena/entry-panel";
import { EvaluationIndicator } from "../arena/panels/evaluation-indicator";
import { EvaluationPanel } from "../arena/panels/evaluation-panel";
import { MoveHistory } from "../arena/panels/move-history";
import { RecoveryNotice } from "../arena/recovery-notice";
import { ServiceStatus } from "../arena/service-status";
import { StatusFeedback } from "../arena/status-feedback";
import { StatusSummary } from "../arena/status-summary";
import { Chessboard, type ChessboardHandle } from "../board/chessboard";
import { standardPositionPreview } from "../position/preview";
import { AppNavigation } from "../shell/app-navigation";
import { AppShell } from "../shell/app-shell";
import { RouteNotice } from "../shell/route-notice";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icon";

import { SandboxCommandRecovery } from "./panels/sandbox-command-recovery";
import { SandboxLifecycleControls } from "./panels/sandbox-lifecycle-controls";
import { SandboxPgnActions } from "./panels/sandbox-pgn-actions";
import { SandboxReplayControls } from "./panels/sandbox-replay-controls";
import { SandboxStartButton } from "./panels/sandbox-start-button";
import { sandboxPresentation } from "./presentation";
import { sandboxStatusPresentation } from "./status-presentation";
import { useSandbox } from "./use-sandbox";

export function SandboxScreen({ apiBaseUrl }: { readonly apiBaseUrl: string }) {
  const { t } = useTranslation();
  const helpId = useId();
  const { state, controller, stopped, departing, retry, recover, checkReadiness, evaluation } =
    useSandbox(apiBaseUrl);
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
  const evaluationPly = state.replay ? state.replayPly : (state.snapshot?.moves.length ?? 0);

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

  if (stopped) {
    return departing ? (
      <RouteNotice kind="loading" />
    ) : (
      <RouteNotice kind="stopped" onRetry={retry} />
    );
  }
  return (
    <AppShell
      mainId="sandbox"
      skipLabel={t("sandbox.skipLink")}
      context={t("app.localDevelopment")}
      navigation={<AppNavigation page="sandbox" />}
      footer={
        <div className="flex flex-col items-center justify-center gap-x-6 gap-y-2 md:flex-row">
          <span>{t(view.board ? "sandbox.sessionFooter" : "sandbox.footer")}</span>
          <ServiceStatus state={state.readiness} />
        </div>
      }
      announcement={view.announcement}
    >
      <ArenaHeader
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
              view.board ? "flex" : "hidden @arena-wide/arena:flex",
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
        players={view.players}
        playAreaLabel={t("arena.playArea")}
        detailsLabel={t("arena.gameDetails")}
        introduction={
          !view.board ? (
            <>
              <EntryPanel
                title={t("sandbox.entryTitle")}
                description={t("sandbox.entryDescription")}
                compactDescription={t("sandbox.entryCompactDescription")}
                action={<SandboxStartButton state={state} controller={controller} />}
              />
              <StatusFeedback {...status} />
              <SandboxCommandRecovery
                state={state}
                controller={controller}
                onRetryRecovery={recover}
                onRetryConnection={checkReadiness}
              />
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
                  <div className="mt-4 @arena-wide/arena:hidden">
                    <RecoveryNotice {...view.recovery} />
                  </div>
                ) : null}
                <SandboxLifecycleControls
                  state={state}
                  controller={controller}
                  boardTools={{ orientation, onFlip: flipBoard, helpId }}
                />
              </>
            ) : (
              <>
                {view.terminal ? (
                  <>
                    <SandboxReplayControls state={state} controller={controller} />
                    <SandboxPgnActions state={state} controller={controller} />
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
                  selectedPly={view.selectedPly}
                  onSelect={state.replay ? (ply) => controller.selectPly(ply) : undefined}
                />
              }
            >
              <div className="shrink-0 border-t border-divider pt-4 text-body text-text-secondary">
                {view.terminal ? (
                  <>
                    <SandboxStartButton state={state} controller={controller} />
                    <p className="mt-6">{t("replay.hint")}</p>
                    <StatusFeedback {...status} />
                  </>
                ) : (
                  <>
                    {view.recovery ? (
                      <div className="hidden @arena-wide/arena:block">
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
                <SandboxCommandRecovery
                  state={state}
                  controller={controller}
                  onRetryRecovery={recover}
                  onRetryConnection={checkReadiness}
                />
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
      {view.board && state.snapshot ? (
        <div className="mx-auto mt-6 grid max-w-[1120px] min-w-0 gap-3">
          <EvaluationIndicator
            state={evaluation.view.plies[evaluationPly]}
            onRetry={() => evaluation.onRetry(evaluationPly)}
            suspended={evaluation.view.suspended}
            accessError={evaluation.view.accessError}
          />
          <details>
            <summary className="min-h-target cursor-pointer py-3 text-label text-accent">
              {t("details.analysis")}
            </summary>
            <EvaluationPanel
              view={evaluation.view}
              selectedPly={evaluationPly}
              moves={state.snapshot.moves}
              onSelect={state.replay ? (ply) => controller.selectPly(ply) : undefined}
              onRetrySave={evaluation.onRetrySave}
            />
          </details>
        </div>
      ) : null}
    </AppShell>
  );
}
