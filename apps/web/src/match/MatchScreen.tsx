import type { ChessColor } from "@neurochess/contracts";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { createAiApi } from "../api/ai-client";
import { aiRequestMessage, providerFailureMessage } from "../api/ai-messages";
import { AppNavigation } from "../app/AppNavigation";
import { AppShell } from "../app/AppShell";
import { ArenaDetails } from "../arena/ArenaDetails";
import { ArenaHeader } from "../arena/ArenaHeader";
import { ArenaLayout } from "../arena/ArenaLayout";
import { BoardTools } from "../arena/BoardTools";
import { AiControls } from "../arena/panels/AiControls";
import { MoveHistory } from "../arena/panels/MoveHistory";
import { PgnActions } from "../arena/panels/PgnActions";
import type { PlayerSummaryData } from "../arena/panels/PlayerSummary";
import { ReplayControls } from "../arena/panels/ReplayControls";
import { setupFieldClass } from "../arena/setup/ModelPicker";
import { StatusSummary } from "../arena/StatusSummary";
import { Chessboard, type ChessboardHandle } from "../board/Chessboard";
import { replayView } from "../position/replay";
import { ArenaSetupScreen } from "../setup/ArenaSetupScreen";
import { Button } from "../ui/Button";

import { humanColor, MatchController, matchKeysReady } from "./controller";

export function MatchScreen({
  apiBaseUrl,
  sandboxEnabled,
}: {
  readonly apiBaseUrl: string;
  readonly sandboxEnabled: boolean;
}) {
  const { t } = useTranslation();
  const [controller] = useState(() => new MatchController(createAiApi(apiBaseUrl)));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => controller.connect(), [controller]);
  const helpId = useId();
  const board = useRef<ChessboardHandle>(null);
  const [flipped, setFlipped] = useState<{ gameId: string; color: ChessColor } | null>(null);
  const human = humanColor(state.details);
  const orientation =
    flipped && flipped.gameId === state.details?.snapshot.gameId
      ? flipped.color
      : (human ?? "white");
  useLayoutEffect(() => {
    if (!state.startedGameId) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) board.current?.focus();
  }, [state.startedGameId]);

  if (state.phase === "setup" && controller.credentials) {
    return (
      <ArenaSetupScreen
        api={controller.api}
        credentials={controller.credentials}
        sandboxEnabled={sandboxEnabled}
        onCreated={(game) => {
          void controller.created(game);
        }}
        onReturnToGame={(id) => {
          void controller.load(id);
        }}
      />
    );
  }

  const { details, issue } = state;
  const snapshot = details?.snapshot;
  const terminal = snapshot?.state === "completed" || snapshot?.state === "aborted";
  const issueText = !issue
    ? null
    : issue.kind === "request"
      ? aiRequestMessage(issue.code, t)
      : issue.kind === "provider"
        ? t("match.providerError", {
            color: t(`players.${issue.color}`),
            message: providerFailureMessage(issue.error, t),
          })
        : t(`match.${issue.code}`);
  const thinkingLabels = (["white", "black"] as const).map((color) =>
    t("match.thinking", { color: t(`players.${color}`) }),
  );
  const status =
    state.phase === "recovering"
      ? t("match.recovering")
      : state.busy
        ? t(controller.hasPendingMove() ? "match.moving" : "match.applying")
        : state.thinking && snapshot
          ? t("match.thinking", { color: t(`players.${snapshot.turn}`) })
          : snapshot?.state === "paused"
            ? t("match.paused")
            : snapshot?.state === "active" && snapshot.turn === human
              ? t("match.yourTurn", { color: t(`players.${human}`) })
              : t("match.waiting");
  const guidance = human
    ? t("match.playing", { color: t(`players.${human}`) })
    : t("match.observing");
  const resultTitle = snapshot?.terminationReason
    ? t(`results.${snapshot.terminationReason}`, {
        winner: t(snapshot.result === "1-0" ? "players.white" : "players.black"),
      })
    : null;
  const lastMove = snapshot?.moves.at(-1);
  const moveAnnouncement = lastMove
    ? t("announcements.move", {
        color: t(lastMove.ply % 2 ? "players.white" : "players.black"),
        move: lastMove.san,
        status: resultTitle ?? status,
      })
    : (resultTitle ?? status);
  const player = (color: ChessColor): PlayerSummaryData => {
    const seat = details?.configuration?.seats[color];
    const activity = terminal
      ? t("players.inspecting")
      : snapshot?.state === "paused"
        ? t("players.paused")
        : state.thinking && snapshot?.turn === color
          ? t("reference.thinking")
          : snapshot?.turn === color && seat?.type === "human"
            ? t("players.toMove")
            : t("players.waiting");
    return {
      identity:
        seat?.type === "ai"
          ? { kind: "ai", provider: t(`setup.providers.${seat.provider}`), model: seat.modelId }
          : { kind: "human", name: t("players.guest") },
      activity: {
        label: activity,
        variants: [
          t("players.inspecting"),
          t("players.paused"),
          t("reference.thinking"),
          t("players.waiting"),
          t("players.toMove"),
        ],
        isTurn: snapshot?.state === "active" && snapshot.turn === color,
      },
    };
  };
  const supported = details?.configuration !== null && details?.configuration !== undefined;
  const canContinue = state.phase === "ready" && !state.thinking && matchKeysReady(state);
  return (
    <AppShell
      mainId="arena-match"
      skipLabel={t("app.skipLink")}
      context={t("setup.session")}
      navigation={<AppNavigation page="arena" sandboxEnabled={sandboxEnabled} />}
      footer={t("match.private")}
      announcement={
        snapshot ? `${moveAnnouncement} ${issueText ?? ""}` : (issueText ?? t("match.loading"))
      }
    >
      <ArenaHeader
        title={resultTitle ?? t("match.title")}
        description={
          snapshot && !terminal ? (
            <StatusSummary
              title={status}
              titleVariants={[
                ...thinkingLabels,
                t("match.yourTurn", { color: t("players.white") }),
                t("match.yourTurn", { color: t("players.black") }),
                t("match.paused"),
                t("match.waiting"),
                t("match.applying"),
                t("match.moving"),
                t("match.recovering"),
              ]}
              pausedLabels={[t("match.paused")]}
            />
          ) : terminal ? (
            t("match.replaying")
          ) : (
            guidance
          )
        }
        score={
          terminal ? (
            <span data-testid="game-score" className="font-display text-title">
              <span className="sr-only">{t("game.score", { score: snapshot.result })}</span>
              <span aria-hidden="true">
                {snapshot.result === "1/2-1/2" ? "½–½" : snapshot.result.replace("-", "–")}
              </span>
            </span>
          ) : undefined
        }
      />
      {!snapshot ? (
        <div className="mx-auto grid max-w-[1120px] gap-4">
          <p>{issueText ?? t("match.loading")}</p>
          {state.phase === "unavailable" ? (
            <Button variant="secondary" onClick={() => controller.retryLoad()}>
              {t("match.retry")}
            </Button>
          ) : null}
        </div>
      ) : !supported ? (
        <div className="grid gap-4">
          <p>{t(details.configuration === null ? "match.sandbox" : "match.unsupported")}</p>
          {details.configuration === null && sandboxEnabled ? (
            <a className="text-accent underline" href={`/sandbox?game=${snapshot.gameId}`}>
              {t("match.openSandbox")}
            </a>
          ) : null}
        </div>
      ) : (
        <ArenaLayout
          players={{ white: player("white"), black: player("black") }}
          playAreaLabel={t("sandbox.playArea")}
          detailsLabel={t("sandbox.gameDetails")}
          board={
            <>
              <Chessboard
                ref={board}
                snapshot={snapshot}
                canMove={controller.canMove()}
                orientation={orientation}
                interactionEpoch={`${snapshot.gameId}:${snapshot.version}:${state.replayPly}`}
                describedBy={helpId}
                view={state.replay ? replayView(state.replay, state.replayPly) : undefined}
                onMove={(move) => {
                  void controller.move(move);
                }}
              />
              {terminal ? (
                <>
                  <ReplayControls
                    available={state.replay !== null}
                    loading={state.replayLoading}
                    count={snapshot.moves.length}
                    ply={state.replayPly}
                    notice={state.replayError ? t("match.replayError") : null}
                    onSelect={(ply) => controller.selectPly(ply)}
                    onRetry={
                      state.replayError
                        ? () => {
                            void controller.loadReplay();
                          }
                        : null
                    }
                  />
                  <PgnActions
                    busy={state.exportBusy}
                    text={state.exportText}
                    feedback={
                      state.exportResult && state.exportResult !== "error"
                        ? t(`export.${state.exportResult}`)
                        : null
                    }
                    error={state.exportResult === "error" ? t("match.exportError") : null}
                    onExport={(kind) => {
                      void controller.exportPgn(kind);
                    }}
                  />
                </>
              ) : (
                <AiControls
                  paused={snapshot.state === "paused" && !state.thinking}
                  busy={state.busy || state.phase === "loading" || state.phase === "recovering"}
                  canContinue={canContinue}
                  canStep={
                    canContinue &&
                    snapshot.state === "paused" &&
                    details.configuration?.seats[snapshot.turn].type === "ai"
                  }
                  epoch={`${snapshot.version}:${state.phase}`}
                  speed={state.speed}
                  onPause={() => {
                    void controller.lifecycle("pause");
                  }}
                  onResume={() => {
                    void controller.continue(false);
                  }}
                  onStep={() => {
                    void controller.continue(true);
                  }}
                  onStop={() => {
                    void controller.lifecycle("abort");
                  }}
                  onSpeed={(speed) => controller.setSpeed(speed)}
                  resignation={
                    human
                      ? {
                          color: human,
                          disabled: state.phase !== "ready",
                          onResign: () => {
                            void controller.lifecycle("resign");
                          },
                        }
                      : undefined
                  }
                />
              )}
              <BoardTools
                helpId={helpId}
                orientation={orientation}
                onFlip={() =>
                  setFlipped({
                    gameId: snapshot.gameId,
                    color: orientation === "white" ? "black" : "white",
                  })
                }
              />
            </>
          }
          details={
            <ArenaDetails
              moves={
                <MoveHistory
                  moves={snapshot.moves}
                  selectedPly={state.replay ? state.replayPly : undefined}
                  onSelect={state.replay ? (ply) => controller.selectPly(ply) : undefined}
                />
              }
            >
              <div className="grid gap-4 border-t border-divider pt-4 text-body">
                {issueText ? <p>{issueText}</p> : null}
                {state.phase === "uncertain" ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      aria-disabled={state.busy}
                      onClick={() => {
                        void controller.recover();
                      }}
                    >
                      {t("match.recover")}
                    </Button>
                    {controller.hasPendingControl() ? (
                      <Button
                        variant="secondary"
                        aria-disabled={state.busy}
                        onClick={() => {
                          void controller.retryControl();
                        }}
                      >
                        {t("match.retryControl")}
                      </Button>
                    ) : null}
                    {controller.hasPendingMove() ? (
                      <Button
                        variant="secondary"
                        aria-disabled={state.busy}
                        onClick={() => {
                          void controller.retryMove();
                        }}
                      >
                        {t("match.retryMove")}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                {terminal ? (
                  <Button variant="primary" onClick={() => controller.newGame()}>
                    {t("match.newGame")}
                  </Button>
                ) : snapshot.state === "paused" ? (
                  <section aria-label={t("match.keys")} className="grid gap-4">
                    {snapshot.turn === human ? <p>{t("match.humanPaused")}</p> : null}
                    <p className="text-label text-text-secondary">
                      {t("setup.sessionOnly")} · {t("setup.sessionOnlyHint")}
                    </p>
                    {(["white", "black"] as const).map((color) => {
                      const seat = details.configuration?.seats[color];
                      return seat?.type === "ai" ? (
                        <div
                          key={`${color}:${state.keyEpoch}`}
                          className="grid min-w-0 gap-2 text-label"
                        >
                          <label htmlFor={`${helpId}-${color}-key`}>
                            {t(`players.${color}`)} · {t(`setup.providers.${seat.provider}`)} ·{" "}
                            {t("setup.apiKey")}
                          </label>
                          <input
                            id={`${helpId}-${color}-key`}
                            aria-describedby={`${helpId}-${color}-hint`}
                            type="password"
                            autoComplete="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            maxLength={4096}
                            className={setupFieldClass}
                            readOnly={state.thinking || state.busy}
                            aria-disabled={state.thinking || state.busy}
                            onChange={(event) => controller.setKey(color, event.target.value)}
                          />
                          <span id={`${helpId}-${color}-hint`} className="text-text-secondary">
                            {t(state.keys[color] ? "match.keyReady" : "match.keyMissing")}
                          </span>
                        </div>
                      ) : null;
                    })}
                  </section>
                ) : (
                  <p className="text-text-secondary">{guidance}</p>
                )}
              </div>
            </ArenaDetails>
          }
        />
      )}
    </AppShell>
  );
}
