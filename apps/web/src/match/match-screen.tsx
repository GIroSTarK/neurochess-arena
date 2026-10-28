import type { ChessColor } from "@neurochess/contracts";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

import type { PublicIdentity } from "../api/identity";
import { ArenaLayout } from "../arena/arena-layout";
import { BoardTools } from "../arena/board-tools";
import { EvaluationIndicator } from "../arena/panels/evaluation-indicator";
import { StatusSummary } from "../arena/status-summary";
import { AccountAccess } from "../auth/account-access";
import { useAccount } from "../auth/context";
import type { ChessboardHandle } from "../board/chessboard";
import { useCredentials } from "../credentials/use-credentials";
import { useGameAnalysis } from "../gameplay/use-game-analysis";
import { useAppRoute } from "../routing/route-context";
import { gameHref } from "../routing/route-urls";
import { ArenaSetupScreen } from "../setup/arena-setup-screen";
import { AppNavigation } from "../shell/app-navigation";
import { AppShell } from "../shell/app-shell";
import { RouteNotice } from "../shell/route-notice";
import { Button } from "../ui/button";
import { TextLink } from "../ui/text-link";

import type { MatchController } from "./controller";
import { AiPacing } from "./panels/ai-pacing";
import { MatchBoard } from "./panels/match-board";
import { MatchDetails } from "./panels/match-details";
import { MatchHeader } from "./panels/match-header";
import { matchPresentation } from "./presentation";
import type { MatchRouteData } from "./route-data";
import type { MatchState } from "./state";

const analysisPosition = (state: MatchState) =>
  state.details?.configuration && state.details.configuration.mode !== "human_vs_human"
    ? {
        snapshot: state.details.snapshot,
        ply: state.replay ? state.replayPly : state.details.snapshot.moves.length,
      }
    : null;

export function MatchScreen({
  identity,
  controller,
  stopped,
  departing,
  onRetry,
  entry,
}: {
  readonly identity?: PublicIdentity;
  readonly controller: MatchController;
  readonly stopped: boolean;
  readonly departing: boolean;
  readonly onRetry: () => void;
  readonly entry: MatchRouteData["data"];
}) {
  const { t } = useTranslation();
  const { sandboxEnabled, apiBaseUrl } = useAppRoute();
  const account = useAccount();
  const navigate = useNavigate();
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const evaluation = useGameAnalysis(
    controller,
    analysisPosition,
    controller.authorizeAnalysis,
    apiBaseUrl,
    identity,
  );
  const evaluationPly = state.replay
    ? state.replayPly
    : (state.details?.snapshot.moves.length ?? 0);
  const view = matchPresentation(state, t, account?.state.profile?.username);
  const boardView = view.board;
  const { refresh, state: savedState } = useCredentials(
    identity,
    !stopped && view.needsCredentials,
    entry?.credentials ?? undefined,
  );
  const savedCredentials =
    identity?.intent === "account"
      ? {
          ...savedState,
          onRefresh: () => {
            void refresh();
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
  const orientation =
    flipped && flipped.gameId === state.details?.snapshot.gameId
      ? flipped.color
      : (view.human ?? "white");
  useLayoutEffect(() => {
    if (!state.startedGameId) return;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) board.current?.focus();
  }, [state.startedGameId]);

  if (stopped) {
    return departing ? (
      <RouteNotice kind="loading" />
    ) : (
      <RouteNotice kind="stopped" onRetry={onRetry} />
    );
  }

  if (state.phase === "setup" && controller.credentials && entry?.entry?.kind === "setup") {
    return (
      <ArenaSetupScreen
        key={state.keyEpoch}
        api={controller.api}
        credentials={controller.credentials}
        entry={entry.entry}
        onRetry={onRetry}
        {...(savedCredentials ? { savedCredentials } : {})}
        onCreated={(game) => {
          void controller.created(game);
        }}
        onReturnToGame={(id) => {
          void navigate(gameHref("arena", id));
        }}
      />
    );
  }

  return (
    <AppShell
      mainId="arena-match"
      skipLabel={t("app.skipLink")}
      context={<AccountAccess />}
      navigation={<AppNavigation page="arena" />}
      footer={t("match.private")}
      announcement={view.announcement}
    >
      <MatchHeader view={view.header} />
      {!boardView ? (
        <div className="mx-auto grid max-w-[1120px] gap-4">
          <p>{view.issueText ?? t("match.loading")}</p>
          {state.phase === "unavailable" ? (
            <Button variant="secondary" onClick={onRetry}>
              {t("match.retry")}
            </Button>
          ) : null}
        </div>
      ) : !state.details?.configuration ? (
        <div className="grid gap-4">
          <p>{t(state.details?.configuration === null ? "match.sandbox" : "match.unsupported")}</p>
          {state.details?.configuration === null && sandboxEnabled ? (
            <TextLink inline to={gameHref("sandbox", boardView.snapshot.gameId)}>
              {t("match.openSandbox")}
            </TextLink>
          ) : null}
        </div>
      ) : (
        <ArenaLayout
          players={view.players}
          playAreaLabel={t("arena.playArea")}
          detailsLabel={t("arena.gameDetails")}
          constrainDetails
          notice={view.header.status ? <StatusSummary {...view.header.status} /> : undefined}
          boardTools={
            <div className="min-w-0">
              <div className="my-3">
                <EvaluationIndicator
                  density="compact"
                  state={evaluation.view.plies[evaluationPly]}
                  onRetry={() => evaluation.onRetry(evaluationPly)}
                  suspended={evaluation.view.suspended}
                  obsolete={evaluation.view.persistence === "obsolete"}
                  accessError={evaluation.view.accessError}
                />
              </div>
              {!view.terminal ? (
                <AiPacing
                  speed={view.controls.speed}
                  onSpeed={(speed) => controller.setSpeed(speed)}
                />
              ) : null}
              <BoardTools
                helpId={helpId}
                orientation={orientation}
                onFlip={() =>
                  setFlipped({
                    gameId: boardView.snapshot.gameId,
                    color: orientation === "white" ? "black" : "white",
                  })
                }
              />
            </div>
          }
          board={
            <MatchBoard
              board={boardView}
              view={view}
              state={state}
              controller={controller}
              orientation={orientation}
              helpId={helpId}
              boardRef={board}
            />
          }
          details={
            <MatchDetails
              state={state}
              view={view}
              controller={controller}
              credentials={savedState.credentials}
              evaluation={evaluation}
              {...(savedCredentials ? { savedCredentials } : {})}
            />
          }
        />
      )}
    </AppShell>
  );
}
