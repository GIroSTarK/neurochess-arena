import type { GameSnapshot } from "@neurochess/contracts";
import type { TFunction } from "i18next";

import type { Announcement, SandboxNotice } from "../game/controller";

const noticeKeys = {
  existing: "notices.existing",
  "sandbox-unavailable": "notices.sandboxUnavailable",
  UNAUTHORIZED: "notices.unauthorized",
  FORBIDDEN: "notices.forbidden",
  NOT_FOUND: "notices.notFound",
  INVALID_REQUEST: "notices.invalidRequest",
  INVALID_UCI: "notices.invalidUci",
  ILLEGAL_MOVE: "notices.illegalMove",
  INVALID_GAME_STATE: "notices.invalidGameState",
  GAME_CONFLICT: "notices.conflict",
  INTERNAL_SERVER_ERROR: "notices.server",
  network: "notices.network",
  timeout: "notices.timeout",
  malformed: "notices.malformed",
  uncertain: "notices.uncertain",
  "sync-required": "notices.syncRequired",
  synchronized: "notices.synchronized",
  recovered: "notices.recovered",
  "recovery-required": "notices.recoveryRequired",
  "pgn-copied": "export.copied",
  "pgn-downloaded": "export.downloaded",
  "pgn-manual": "export.manual",
} as const satisfies Record<SandboxNotice, string>;

export function noticeMessage(notice: SandboxNotice, t: TFunction): string {
  return t(noticeKeys[notice]);
}

export function resultTitle(snapshot: GameSnapshot, t: TFunction): string {
  if (snapshot.state === "aborted") return t("game.stopped");
  if (snapshot.result === "1-0") return t("game.whiteWins");
  if (snapshot.result === "0-1") return t("game.blackWins");
  return t("game.draw");
}

export function gameStatus(snapshot: GameSnapshot, t: TFunction): string {
  if (snapshot.state === "paused") return t("game.pausedTitle");
  if (snapshot.state === "configuring") return t("game.configuring");
  if (snapshot.terminationReason) {
    return t("game.resultWithScore", {
      result: resultTitle(snapshot, t),
      reason: t(`reasons.${snapshot.terminationReason}`),
      score: snapshot.result,
    });
  }
  return t(snapshot.inCheck ? "game.turnInCheck" : "game.turn", {
    color: t(`players.${snapshot.turn}`),
  });
}

export function announcementMessage(event: Announcement | null, t: TFunction): string {
  if (!event) return "";
  if (event.kind === "notice") return noticeMessage(event.notice, t);
  if (event.kind === "connection") return t(`connection.${event.readiness}`);
  if (event.kind === "replay")
    return event.ply === 0
      ? t("replay.initial")
      : t("replay.selected", { ply: event.ply, move: event.san ?? "" });
  const status = gameStatus(event.snapshot, t);
  if (event.kind === "move") {
    const lastMove = event.snapshot.moves.at(-1);
    if (!lastMove) return status;
    return t("announcements.move", {
      color: t(lastMove.ply % 2 === 1 ? "players.white" : "players.black"),
      move: lastMove.san,
      status,
    });
  }
  if (event.kind === "rejected") {
    return t("announcements.rejected", { reason: noticeMessage(event.reason, t), status });
  }
  return t(`announcements.${event.kind}`, { status });
}
