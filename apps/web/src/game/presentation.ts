import type { ChessColor, GameSnapshot } from "@neurochess/contracts";
import type { TFunction } from "i18next";

import type { PlayerSummaryData } from "../arena/panels/PlayerSummary";
import { replayView } from "../position/replay";

import { announcementMessage } from "./messages";
import { interactionEpoch, isTerminal, isUnfinished, type SandboxState } from "./state";

const activityKeys = ["ready", "inspecting", "paused", "toMove", "waiting"] as const;

function player(color: ChessColor, snapshot: GameSnapshot | null, t: TFunction): PlayerSummaryData {
  const isTurn = snapshot?.state === "active" && snapshot.turn === color;
  const activity = !snapshot
    ? "ready"
    : snapshot.state === "paused"
      ? "paused"
      : snapshot.state !== "active"
        ? "inspecting"
        : isTurn
          ? "toMove"
          : "waiting";
  return {
    identity: { kind: "human", name: t("players.guest") },
    activity: {
      label: t(`players.${activity}`),
      variants: activityKeys.map((key) => t(`players.${key}`)),
      isTurn,
    },
  };
}

export function sandboxPresentation(state: SandboxState, t: TFunction) {
  const { snapshot } = state;
  const lastMove = snapshot?.moves.at(-1);
  const recovered =
    snapshot?.state === "paused" &&
    (state.notice === "recovered" ||
      state.notice === "existing" ||
      state.announcement?.kind === "existing");
  const result = snapshot?.terminationReason
    ? {
        title: t(`results.${snapshot.terminationReason}`, {
          winner: t(snapshot.result === "1-0" ? "players.white" : "players.black"),
        }),
        description: t(lastMove ? "sandbox.resultContextWithMove" : "sandbox.resultContext", {
          status: t(snapshot.state === "aborted" ? "reasons.aborted" : "game.complete"),
          move: lastMove
            ? `${Math.ceil(lastMove.ply / 2)}${lastMove.ply % 2 === 0 ? "..." : "."} ${lastMove.san}`
            : "",
        }),
        score: snapshot.result === "1/2-1/2" ? "½–½" : snapshot.result.replace("-", "–"),
        scoreLabel: t("game.score", { score: snapshot.result }),
      }
    : null;
  return {
    result,
    recovery: recovered
      ? {
          title: t("sandbox.recoveredTitle"),
          description: t("sandbox.recoveredDescription"),
          hint: t("sandbox.resumeHint"),
        }
      : null,
    players: { white: player("white", snapshot, t), black: player("black", snapshot, t) },
    live: snapshot !== null && isUnfinished(snapshot),
    board: snapshot
      ? {
          snapshot,
          canMove: state.phase === "ready" && snapshot.state === "active" && state.replay === null,
          interactionEpoch: interactionEpoch(state),
          view: state.replay ? replayView(state.replay, state.replayPly) : undefined,
        }
      : null,
    terminal: snapshot !== null && isTerminal(snapshot),
    moves: snapshot?.moves ?? [],
    selectedPly: state.replay ? state.replayPly : undefined,
    startedGameId:
      state.announcement?.kind === "started" ? state.announcement.snapshot.gameId : null,
    announcement: announcementMessage(state.announcement, t),
  };
}
