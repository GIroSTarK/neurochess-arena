import type { TFunction } from "i18next";

import type { StatusPresentation } from "../arena/status";

import { isRejectionCode } from "./failures";
import { gameStatus, noticeMessage, resultTitle } from "./messages";
import { isUnfinished, type SandboxState } from "./state";

const activityKeys = [
  "actions.starting",
  "game.submitting",
  "lifecycle.submitting",
  "game.synchronizing",
  "game.recovering",
] as const;

type ActivityKey = (typeof activityKeys)[number];

function activityKey({ phase, pendingCommand }: SandboxState): ActivityKey | undefined {
  switch (phase) {
    case "starting":
      return "actions.starting";
    case "submitting":
      return "action" in pendingCommand ? "lifecycle.submitting" : "game.submitting";
    case "synchronizing":
      return "game.synchronizing";
    case "recovering":
      return "game.recovering";
    default:
      return undefined;
  }
}

// Routine notices share reserved space; errors may expand for readability.
const routineNotices = ["existing", "recovered", "synchronized"] as const;

export function sandboxStatusPresentation(state: SandboxState, t: TFunction): StatusPresentation {
  const { snapshot } = state;
  const unfinished = snapshot !== null && isUnfinished(snapshot);
  const activity = activityKey(state);
  const busy = activity !== undefined;
  const routineNotice = unfinished && routineNotices.some((notice) => notice === state.notice);
  const title = snapshot
    ? snapshot.terminationReason
      ? resultTitle(snapshot, t)
      : gameStatus(snapshot, t)
    : t("game.beforeStart");
  const titleVariants = unfinished
    ? (["white", "black"] as const).flatMap((color) => [
        t("game.pausedTurn", { color: t(`players.${color}`) }),
        t("game.turn", { color: t(`players.${color}`) }),
        t("game.turnInCheck", { color: t(`players.${color}`) }),
      ])
    : [];

  return {
    title,
    titleVariants,
    feedback:
      busy || unfinished
        ? {
            activeId: activity ?? null,
            activities: activityKeys.map((id) => ({ id, label: t(id) })),
            notices: unfinished
              ? routineNotices.map((id) => ({
                  id,
                  label: noticeMessage(id, t),
                  visible: state.notice === id,
                }))
              : [],
          }
        : null,
    notice: state.notice && !routineNotice ? noticeMessage(state.notice, t) : null,
    followUp:
      state.phase === "ready" && isRejectionCode(state.notice) ? t("notices.synchronized") : null,
  };
}
