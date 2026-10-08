import type { ChessColor } from "@neurochess/contracts";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";

import type { AiIdentity } from "../api/identity";
import { AppNavigation } from "../app/AppNavigation";
import { AppShell } from "../app/AppShell";
import { gameHref } from "../app/route-urls";
import { RouteNotice } from "../app/RouteNotice";
import { ArenaLayout } from "../arena/ArenaLayout";
import { BoardTools } from "../arena/BoardTools";
import { AccountAccess } from "../auth/AccountAccess";
import { useAccount } from "../auth/context";
import type { ChessboardHandle } from "../board/Chessboard";
import { useCredentials } from "../credentials/use-credentials";
import { ArenaSetupScreen } from "../setup/ArenaSetupScreen";
import { Button } from "../ui/Button";

import type { MatchController } from "./controller";
import { MatchBoard } from "./panels/MatchBoard";
import { MatchDetails } from "./panels/MatchDetails";
import { MatchHeader } from "./panels/MatchHeader";
import { matchPresentation } from "./presentation";
import type { ArenaRouteData } from "./route-data";

export function MatchScreen({
  sandboxEnabled,
  identity,
  controller,
  stopped,
  departing,
  onRetry,
  entry,
}: {
  readonly sandboxEnabled: boolean;
  readonly identity?: AiIdentity;
  readonly controller: MatchController;
  readonly stopped: boolean;
  readonly departing: boolean;
  readonly onRetry: () => void;
  readonly entry: ArenaRouteData["data"];
}) {
  const { t } = useTranslation();
  const account = useAccount();
  const navigate = useNavigate();
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
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
      <RouteNotice kind="loading" sandboxEnabled={sandboxEnabled} />
    ) : (
      <RouteNotice kind="stopped" sandboxEnabled={sandboxEnabled} onRetry={onRetry} />
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

  return (
    <AppShell
      mainId="arena-match"
      skipLabel={t("app.skipLink")}
      context={<AccountAccess />}
      navigation={<AppNavigation page="arena" sandboxEnabled={sandboxEnabled} />}
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
            <Link
              className="text-accent underline"
              to={gameHref("sandbox", boardView.snapshot.gameId)}
            >
              {t("match.openSandbox")}
            </Link>
          ) : null}
        </div>
      ) : (
        <ArenaLayout
          players={view.players}
          playAreaLabel={t("arena.playArea")}
          detailsLabel={t("arena.gameDetails")}
          constrainDetails
          boardTools={
            <div className="min-w-0">
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
              {...(savedCredentials ? { savedCredentials } : {})}
            />
          }
        />
      )}
    </AppShell>
  );
}
