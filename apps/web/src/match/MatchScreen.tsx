import type { ChessColor } from "@neurochess/contracts";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import type { AiIdentity } from "../api/ai-client";
import { aiRequestMessage, providerFailureMessage } from "../api/ai-messages";
import { AppNavigation } from "../app/AppNavigation";
import { AppShell } from "../app/AppShell";
import { gameHref } from "../app/route-urls";
import { RouteNotice } from "../app/RouteNotice";
import { ArenaDetails } from "../arena/ArenaDetails";
import { ArenaHeader } from "../arena/ArenaHeader";
import { ArenaLayout } from "../arena/ArenaLayout";
import { BoardTools } from "../arena/BoardTools";
import { AiControls } from "../arena/panels/AiControls";
import { MoveHistory } from "../arena/panels/MoveHistory";
import { PgnActions } from "../arena/panels/PgnActions";
import type { PlayerSummaryData } from "../arena/panels/PlayerSummary";
import { ReplayControls } from "../arena/panels/ReplayControls";
import { StatusSummary } from "../arena/StatusSummary";
import { AccountAccess } from "../auth/AccountAccess";
import { useAccount } from "../auth/context";
import { Chessboard, type ChessboardHandle } from "../board/Chessboard";
import { useCredentials } from "../credentials/use-credentials";
import { replayView } from "../position/replay";
import { ArenaSetupScreen } from "../setup/ArenaSetupScreen";
import { Button } from "../ui/Button";
import { StableText } from "../ui/StableText";

import { CommentaryPanel } from "./CommentaryPanel";
import { humanColor, type MatchController, matchKeysReady } from "./controller";
import { InvocationEvents } from "./InvocationEvents";
import { PausedCredentials } from "./PausedCredentials";
import type { ArenaRouteData } from "./route-data";
import { TelemetryPanel } from "./TelemetryPanel";

export function MatchScreen({
  apiBaseUrl,
  sandboxEnabled,
  identity,
  controller,
  stopped,
  onRetry,
  entry,
}: {
  readonly apiBaseUrl: string;
  readonly sandboxEnabled: boolean;
  readonly identity?: AiIdentity;
  readonly controller: MatchController;
  readonly stopped: boolean;
  readonly onRetry: () => void;
  readonly entry: ArenaRouteData["data"];
}) {
  const { t } = useTranslation();
  const account = useAccount();
  const navigate = useNavigate();
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const needsCredentials =
    state.phase === "setup" ||
    (state.details?.configuration != null &&
      (state.details.snapshot.state === "active" || state.details.snapshot.state === "paused"));
  const { catalog, state: savedState } = useCredentials(
    apiBaseUrl,
    identity,
    !stopped && needsCredentials,
    entry?.credentials ?? undefined,
  );
  const savedCredentials = catalog.api
    ? {
        ...savedState,
        onRefresh: () => {
          void catalog.refresh();
        },
      }
    : undefined;
  useEffect(() => {
    if (savedState.phase === "ready") controller.reconcileSavedCredentials(savedState.credentials);
  }, [
    controller,
    savedState.phase,
    savedState.credentials,
    state.details?.snapshot.state,
    state.thinking,
    state.busy,
  ]);
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

  if (stopped) {
    return <RouteNotice kind="stopped" sandboxEnabled={sandboxEnabled} onRetry={onRetry} />;
  }

  if (state.phase === "setup" && controller.credentials) {
    return (
      <ArenaSetupScreen
        key={state.keyEpoch}
        api={controller.api}
        credentials={controller.credentials}
        {...(entry?.entry?.kind === "setup" ? { entry: entry.entry } : {})}
        onRetry={onRetry}
        {...(savedCredentials ? { savedCredentials } : {})}
        sandboxEnabled={sandboxEnabled}
        onCreated={(game) => {
          void controller.created(game);
        }}
        onReturnToGame={(id) => {
          void navigate(gameHref("arena", id));
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
          : { kind: "human", name: account?.state.profile?.username ?? t("players.guest") },
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
  const configuration = details?.configuration;
  const canContinue = state.phase === "ready" && !state.thinking && matchKeysReady(state);
  const detailMessage = issue?.kind === "notice" && issue.code === "recovered" ? null : issueText;
  const detailGuidance =
    snapshot?.state === "paused"
      ? t(snapshot.turn === human ? "match.humanPaused" : "match.aiPaused")
      : guidance;
  return (
    <AppShell
      mainId="arena-match"
      skipLabel={t("app.skipLink")}
      context={<AccountAccess />}
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
            <Button variant="secondary" onClick={onRetry}>
              {t("match.retry")}
            </Button>
          ) : null}
        </div>
      ) : !configuration ? (
        <div className="grid gap-4">
          <p>{t(details.configuration === null ? "match.sandbox" : "match.unsupported")}</p>
          {details.configuration === null && sandboxEnabled ? (
            <Link className="text-accent underline" to={gameHref("sandbox", snapshot.gameId)}>
              {t("match.openSandbox")}
            </Link>
          ) : null}
        </div>
      ) : (
        <ArenaLayout
          players={{ white: player("white"), black: player("black") }}
          playAreaLabel={t("sandbox.playArea")}
          detailsLabel={t("sandbox.gameDetails")}
          constrainDetails
          boardTools={
            <div className="min-w-0">
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
            </div>
          }
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
            </>
          }
          details={
            <PausedCredentials
              epoch={`${snapshot.gameId}:${snapshot.version}:${state.keyEpoch}`}
              paused={snapshot.state === "paused" && state.phase === "ready"}
              seats={configuration.seats}
              keys={state.keys}
              selections={state.selections}
              {...(savedCredentials ? { savedCredentials } : {})}
              onCredentialChange={(color, value) =>
                controller.setCredential(color, value, savedState.credentials)
              }
              rejectedColor={
                issue?.kind === "provider" && issue.error.code === "provider_auth"
                  ? issue.color
                  : null
              }
              disabled={state.thinking || state.busy}
              canContinue={canContinue}
              onKeyChange={(color, value) => controller.setKey(color, value)}
              onResume={() => {
                void controller.continue(false);
              }}
              notice={
                issue?.kind === "provider" && issue.error.code !== "provider_auth"
                  ? issueText
                  : null
              }
            >
              <ArenaDetails
                commentary={
                  <CommentaryPanel
                    key={snapshot.gameId}
                    details={details}
                    records={state.invocations}
                    selectedPly={terminal ? state.replayPly : null}
                    loading={state.invocationsLoading}
                    error={state.invocationsError}
                  />
                }
                analysis={
                  <TelemetryPanel
                    details={details}
                    records={state.invocations}
                    recordedMoveCount={state.invocationsMoveCount}
                    loading={state.invocationsLoading}
                    error={state.invocationsError}
                    onRefresh={() => {
                      void controller.loadInvocations();
                    }}
                  />
                }
                events={
                  <InvocationEvents
                    records={state.invocations}
                    snapshot={snapshot}
                    loading={state.invocationsLoading}
                    error={state.invocationsError}
                  />
                }
                moves={
                  <MoveHistory
                    showHeading={false}
                    moves={snapshot.moves}
                    selectedPly={state.replay ? state.replayPly : undefined}
                    onSelect={state.replay ? (ply) => controller.selectPly(ply) : undefined}
                  />
                }
              >
                <div className="grid shrink-0 gap-4 border-t border-divider pt-4 text-body">
                  {!terminal || detailMessage ? (
                    <p className="text-text-secondary">
                      <StableText
                        value={detailMessage ?? detailGuidance}
                        variants={[guidance, t("match.humanPaused"), t("match.aiPaused")]}
                      />
                    </p>
                  ) : null}
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
                  ) : null}
                </div>
              </ArenaDetails>
            </PausedCredentials>
          }
        />
      )}
    </AppShell>
  );
}
