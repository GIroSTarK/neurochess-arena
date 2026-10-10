import { useId, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { ArenaHeader } from "../arena/arena-header";
import { ArenaLayout } from "../arena/arena-layout";
import { MoveHistory } from "../arena/panels/move-history";
import { PgnActions } from "../arena/panels/pgn-actions";
import type { PlayerSummaryData } from "../arena/panels/player-summary";
import { ReplayControls } from "../arena/panels/replay-controls";
import { resultReason, resultTitle } from "../arena/result";
import { AccountAccess } from "../auth/account-access";
import { Chessboard } from "../board/chessboard";
import { isTerminal, plyColor } from "../gameplay/snapshot";
import { replayView } from "../position/replay";
import { AppNavigation } from "../shell/app-navigation";
import { AppShell } from "../shell/app-shell";
import { Button } from "../ui/button";
import { TextLink } from "../ui/text-link";

import type { RoomController } from "./controller";
import { InvitationShare } from "./invitation-share";
import { RoomControls } from "./room-controls";

export function RoomScreen({
  controller,
  onRetry,
}: {
  readonly controller: RoomController;
  readonly onRetry: () => void;
}) {
  const { t } = useTranslation();
  const helpId = useId();
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const room = state.room;
  const snapshot = room?.snapshot;
  const terminal = snapshot && isTerminal(snapshot);
  const title = terminal
    ? resultTitle(snapshot, t)
    : room?.state === "waiting"
      ? t("rooms.waiting")
      : t("rooms.title");
  const connection = t(`rooms.connection.${state.connection}`);
  const status = terminal
    ? snapshot.terminationReason
      ? resultReason({ result: snapshot.result, terminationReason: snapshot.terminationReason }, t)
      : title
    : room?.state === "waiting"
      ? t("rooms.waitingColor", {
          color: t(`players.${room.ownerColor === "white" ? "black" : "white"}`),
        })
      : snapshot
        ? t(snapshot.inCheck ? "game.turnInCheck" : "game.turn", {
            color: t(`players.${snapshot.turn}`),
          })
        : t("routing.loading");
  const playerSummary = (color: "white" | "black"): PlayerSummaryData => {
    const player = room?.players[color];
    const name =
      player?.kind === "account"
        ? player.username
        : t(`history.players.${player?.kind ?? "unassigned"}`);
    const label = state.online
      ? t(state.online[color] ? "rooms.online" : "rooms.offline")
      : t("rooms.presenceUnknown");
    return {
      identity: { kind: "human", name },
      activity: {
        label,
        variants: [t("rooms.online"), t("rooms.offline"), t("rooms.presenceUnknown")],
        isTurn: !terminal && room?.state === "joined" && snapshot?.turn === color,
      },
    };
  };
  const players = { white: playerSummary("white"), black: playerSummary("black") };
  const exportPhase = state.exportPhase;
  const lastMove = snapshot?.moves.at(-1);
  const announcement = state.replay
    ? [
        t("replay.position", { ply: state.replayPly, count: state.replay.snapshot.moves.length }),
        state.replay.snapshot.moves[state.replayPly - 1]?.san,
        status,
      ]
        .filter(Boolean)
        .join(". ")
    : lastMove
      ? t("announcements.move", {
          color: t(`players.${plyColor(lastMove.ply)}`),
          move: lastMove.san,
          status,
        })
      : status;
  return (
    <AppShell
      mainId="room-game"
      skipLabel={t("app.skipLink")}
      context={<AccountAccess />}
      navigation={<AppNavigation page="rooms" />}
      footer={t("match.private")}
      announcement={`${announcement} ${connection}`}
    >
      <ArenaHeader
        title={title}
        description={
          room ? t("rooms.yourColor", { color: t(`players.${room.viewer.color}`) }) : connection
        }
      />
      {!room || !snapshot ? (
        <div className="grid gap-4">
          <p role="alert">
            {state.connection === "access"
              ? t("rooms.errors.access")
              : state.connection === "failed"
                ? t("rooms.playErrors.unavailable")
                : t("routing.loading")}
          </p>
          {state.connection === "failed" ? (
            <Button variant="secondary" onClick={onRetry}>
              {t("match.retry")}
            </Button>
          ) : null}
        </div>
      ) : (
        <ArenaLayout
          players={players}
          playAreaLabel={t("arena.playArea")}
          detailsLabel={t("arena.gameDetails")}
          board={
            <>
              <Chessboard
                snapshot={snapshot}
                orientation={room.viewer.color}
                canMove={state.canMove}
                interactionEpoch={`${snapshot.gameId}:${snapshot.version}:${state.interactionRevision}`}
                describedBy={helpId}
                view={state.replay ? replayView(state.replay, state.replayPly) : undefined}
                onMove={(move) => {
                  void controller.move(move);
                }}
              />
              <p id={helpId} className="mt-3 text-caption text-text-secondary">
                {t(terminal ? "rooms.replayHint" : "rooms.boardHint")}
              </p>
              <RoomControls controller={controller} state={state} />
              {terminal ? (
                <>
                  <ReplayControls
                    available={state.replay !== null}
                    loading={state.replayPhase === "loading"}
                    count={snapshot.moves.length}
                    ply={state.replayPly}
                    notice={state.replayPhase === "error" ? t("match.replayError") : null}
                    onSelect={controller.selectPly}
                    onRetry={
                      state.replayPhase === "error"
                        ? () => {
                            void controller.loadReplay();
                          }
                        : null
                    }
                  />
                  <PgnActions
                    busy={exportPhase === "loading"}
                    text={state.exportText}
                    feedback={
                      exportPhase === "copied" ||
                      exportPhase === "downloaded" ||
                      exportPhase === "manual"
                        ? t(`export.${exportPhase}`)
                        : null
                    }
                    error={exportPhase === "error" ? t("match.exportError") : null}
                    onExport={(kind) => {
                      void controller.exportPgn(kind);
                    }}
                  />
                </>
              ) : null}
            </>
          }
          details={
            <>
              <p className="text-section font-semibold">{status}</p>
              <p className="text-label text-text-secondary" data-testid="room-connection">
                {connection}
              </p>
              {state.connection === "failed" ? (
                <Button variant="secondary" onClick={() => controller.reconnect()}>
                  {t("rooms.reconnect")}
                </Button>
              ) : null}
              {state.issue ? <p role="alert">{t(`rooms.playErrors.${state.issue}`)}</p> : null}
              {state.pendingMove ? (
                <Button
                  variant="secondary"
                  aria-disabled={state.busy || state.connection !== "synchronized"}
                  onClick={() => {
                    void controller.retryMove();
                  }}
                >
                  {t("rooms.retryMove")}
                </Button>
              ) : null}
              {room.state === "waiting" && !terminal ? (
                <div className="grid min-w-0 gap-4">
                  {state.invitation ? (
                    <InvitationShare key={state.invitation} invitation={state.invitation} />
                  ) : (
                    <p>{t("rooms.replaceHint")}</p>
                  )}
                  {!room.invitationAvailable ? <p>{t("rooms.revoked")}</p> : null}
                </div>
              ) : null}
              <MoveHistory
                moves={snapshot.moves}
                selectedPly={state.replay ? state.replayPly : undefined}
                onSelect={state.replay ? controller.selectPly : undefined}
              />
              {terminal ? <TextLink to="/rooms">{t("rooms.newRoom")}</TextLink> : null}
            </>
          }
        />
      )}
    </AppShell>
  );
}
