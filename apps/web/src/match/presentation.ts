import type { ChessColor } from "@neurochess/contracts";
import type { TFunction } from "i18next";

import { aiRequestMessage, providerFailureMessage } from "../api/ai-messages";
import type { PlayerSummaryData } from "../arena/panels/player-summary";
import { resultReason, resultScore } from "../arena/result";
import { isTerminal, plyColor } from "../gameplay/snapshot";
import { replayView } from "../position/replay";

import { humanColor, matchKeysReady, type MatchState } from "./state";

const activityKeys = ["inspecting", "paused", "thinking", "waiting", "toMove"] as const;

function player(
  color: ChessColor,
  state: MatchState,
  terminal: boolean,
  t: TFunction,
  username: string | null | undefined,
): PlayerSummaryData {
  const snapshot = state.details?.snapshot;
  const seat = state.details?.configuration?.seats[color];
  const activity = terminal
    ? "inspecting"
    : snapshot?.state === "paused"
      ? "paused"
      : state.thinking && snapshot?.turn === color
        ? "thinking"
        : snapshot?.turn === color && seat?.type === "human"
          ? "toMove"
          : "waiting";
  return {
    identity:
      seat?.type === "ai"
        ? { kind: "ai", provider: t(`setup.providers.${seat.provider}`), model: seat.modelId }
        : { kind: "human", name: username ?? t("players.guest") },
    activity: {
      label: t(`players.${activity}`),
      variants: activityKeys.map((key) => t(`players.${key}`)),
      isTurn: snapshot?.state === "active" && snapshot.turn === color,
    },
  };
}

export function matchPresentation(state: MatchState, t: TFunction, username?: string | null) {
  const { details, issue } = state;
  const snapshot = details?.snapshot;
  const human = humanColor(details);
  const terminal = snapshot !== undefined && isTerminal(snapshot);
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
  const status =
    state.phase === "recovering"
      ? t("match.recovering")
      : state.busy
        ? t(state.pendingMove ? "match.moving" : "match.applying")
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
  const resultTitle = snapshot?.terminationReason ? resultReason(snapshot, t) : null;
  const lastMove = snapshot?.moves.at(-1);
  const moveAnnouncement = lastMove
    ? t("announcements.move", {
        color: t(`players.${plyColor(lastMove.ply)}`),
        move: lastMove.san,
        status: resultTitle ?? status,
      })
    : (resultTitle ?? status);
  const canContinue = state.phase === "ready" && !state.thinking && matchKeysReady(state);
  const detailMessage = issue?.kind === "notice" && issue.code === "recovered" ? null : issueText;
  const detailGuidance =
    snapshot?.state === "paused"
      ? t(snapshot.turn === human ? "match.humanPaused" : "match.aiPaused")
      : guidance;

  return {
    human,
    terminal,
    issueText,
    needsCredentials:
      state.phase === "setup" ||
      (details?.configuration != null &&
        (snapshot?.state === "active" || snapshot?.state === "paused")),
    header: {
      title: resultTitle ?? t("match.title"),
      description: terminal ? t("match.replaying") : guidance,
      status:
        snapshot && !terminal
          ? {
              title: status,
              titleVariants: [
                ...(["white", "black"] as const).map((color) =>
                  t("match.thinking", { color: t(`players.${color}`) }),
                ),
                t("match.yourTurn", { color: t("players.white") }),
                t("match.yourTurn", { color: t("players.black") }),
                t("match.paused"),
                t("match.waiting"),
                t("match.applying"),
                t("match.moving"),
                t("match.recovering"),
              ],
              pausedLabels: [t("match.paused")],
            }
          : null,
      result: terminal
        ? {
            score: resultScore(snapshot.result),
            scoreLabel: t("game.score", { score: snapshot.result }),
          }
        : null,
    },
    announcement: snapshot
      ? `${moveAnnouncement} ${issueText ?? ""}`
      : (issueText ?? t("match.loading")),
    players: {
      white: player("white", state, terminal, t, username),
      black: player("black", state, terminal, t, username),
    },
    board: snapshot
      ? {
          snapshot,
          canMove: state.canMove,
          interactionEpoch: `${snapshot.gameId}:${snapshot.version}:${state.replayPly}`,
          view: state.replay ? replayView(state.replay, state.replayPly) : undefined,
        }
      : null,
    controls: {
      paused: snapshot?.state === "paused" && !state.thinking,
      busy: state.busy || state.phase === "loading" || state.phase === "recovering",
      canContinue,
      canStep:
        canContinue &&
        snapshot?.state === "paused" &&
        details?.configuration?.seats[snapshot.turn].type === "ai",
      epoch: snapshot ? `${snapshot.version}:${state.phase}` : "",
      speed: state.speed,
      resignation: human ? { color: human, disabled: state.phase !== "ready" } : undefined,
    },
    details: {
      message: !terminal || detailMessage ? (detailMessage ?? detailGuidance) : null,
      variants: [guidance, t("match.humanPaused"), t("match.aiPaused")],
    },
    credentials: {
      epoch: snapshot ? `${snapshot.gameId}:${snapshot.version}:${state.keyEpoch}` : "",
      paused: snapshot?.state === "paused" && state.phase === "ready",
      keys: state.keys,
      selections: state.selections,
      rejectedColor:
        issue?.kind === "provider" && issue.error.code === "provider_auth" ? issue.color : null,
      disabled: state.thinking || state.busy,
      canContinue,
      notice: issue?.kind === "provider" && issue.error.code !== "provider_auth" ? issueText : null,
    },
  };
}

export type MatchPresentation = ReturnType<typeof matchPresentation>;
