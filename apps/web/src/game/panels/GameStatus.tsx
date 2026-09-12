import { useTranslation } from "react-i18next";

import { GameStatus as GameStatusPanel } from "../../arena/panels/GameStatus";
import { Button } from "../../ui/Button";
import type { SandboxController } from "../controller";
import { isRejectionCode } from "../failures";
import { gameStatus, noticeMessage, resultTitle } from "../messages";
import { isTerminal, isUnfinished, type SandboxState } from "../state";

import { LifecycleControls } from "./LifecycleControls";

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

type StatusController = Pick<
  SandboxController,
  "checkReadiness" | "lifecycle" | "recover" | "retryCommand" | "start" | "synchronize"
>;

export function GameStatus({
  state,
  controller,
}: {
  readonly state: SandboxState;
  readonly controller: StatusController;
}) {
  const { t } = useTranslation();
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
    ? [
        t("game.pausedTitle"),
        ...(["white", "black"] as const).flatMap((color) => [
          t("game.turn", { color: t(`players.${color}`) }),
          t("game.turnInCheck", { color: t(`players.${color}`) }),
        ]),
      ]
    : [];

  return (
    <GameStatusPanel
      title={title}
      titleVariants={titleVariants}
      lifecycle={
        snapshot
          ? {
              state: snapshot.state,
              label: t(`game.${snapshot.state}`),
              variants: unfinished ? [t("game.active"), t("game.paused")] : [],
            }
          : null
      }
      result={
        snapshot?.terminationReason
          ? {
              reason: t(`reasons.${snapshot.terminationReason}`),
              score: snapshot.result,
            }
          : null
      }
      description={
        !snapshot
          ? t("game.beforeStartHint")
          : snapshot.state === "configuring"
            ? t("game.configuringHint")
            : null
      }
      feedback={
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
          : null
      }
      notice={state.notice && !routineNotice ? noticeMessage(state.notice, t) : null}
      followUp={
        state.phase === "ready" && isRejectionCode(state.notice) ? t("notices.synchronized") : null
      }
    >
      {state.phase === "uncertain" || state.phase === "sync-required" ? (
        <div className="flex flex-col items-stretch gap-3">
          <p className="text-text-secondary">{t("game.uncertainHint")}</p>
          {state.phase === "uncertain" ? (
            <Button
              variant="primary"
              onClick={() => {
                void controller.retryCommand();
              }}
            >
              {t("action" in state.pendingCommand ? "actions.retryCommand" : "actions.retryMove")}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            onClick={() => {
              void controller.synchronize();
            }}
          >
            {t("actions.synchronize")}
          </Button>
        </div>
      ) : null}
      {state.phase === "recovery-required" ? (
        <Button
          variant="primary"
          onClick={() => {
            void controller.recover();
          }}
        >
          {t("actions.retryRecovery")}
        </Button>
      ) : null}
      {unfinished ? (
        <LifecycleControls key={snapshot.gameId} state={state} controller={controller} />
      ) : null}
      {snapshot && isTerminal(snapshot) ? (
        <Button
          variant="primary"
          className="mt-6"
          aria-disabled={busy || state.readiness !== "ready"}
          onClick={() => {
            void controller.start();
          }}
        >
          {t("actions.newGame")}
        </Button>
      ) : null}
      {state.readiness === "unavailable" ? (
        <Button
          variant="secondary"
          onClick={() => {
            void controller.checkReadiness();
          }}
        >
          {t("actions.retryConnection")}
        </Button>
      ) : null}
    </GameStatusPanel>
  );
}
