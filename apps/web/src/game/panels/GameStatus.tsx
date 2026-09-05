import type { GameState } from "@neurochess/contracts";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../ui/Button";
import { cx } from "../../ui/cx";
import { StableText } from "../../ui/StableText";
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

// Labels and shapes keep lifecycle distinguishable without color.
const lifecycleMarks: Record<GameState, string> = {
  configuring: "before:rounded-full before:bg-current",
  active: "before:rounded-full before:bg-accent",
  paused: "before:rounded-none before:bg-warning",
  completed: "before:rounded-full before:bg-success",
  aborted: "before:rounded-full before:bg-current",
};

// Hidden variants stay in the shared grid cell to reserve the tallest localized content.
const feedbackSlotClassName = "min-w-0 self-start [grid-area:1/1] aria-hidden:invisible";

const noticeClassName = "border-l-2 border-warning pl-3 text-text";

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
  const headingId = useId();
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
    <section className="rounded-panel bg-surface p-6 max-sm:p-4" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-label text-text-secondary">{t("game.status")}</p>
        {snapshot ? (
          <span
            className={cx(
              "inline-flex items-center gap-2 text-right text-label text-text-muted before:size-[0.4rem] before:shrink-0 before:content-['']",
              lifecycleMarks[snapshot.state],
            )}
          >
            <StableText
              value={t(`game.${snapshot.state}`)}
              variants={unfinished ? [t("game.active"), t("game.paused")] : []}
            />
          </span>
        ) : null}
      </div>
      <h2 id={headingId} className="mt-4 text-title font-semibold max-sm:text-[1.5rem]/8">
        <StableText value={title} variants={titleVariants} />
      </h2>
      {snapshot?.terminationReason ? (
        <p className="mt-3 flex flex-wrap items-baseline justify-between gap-2 text-text-secondary">
          {t(`reasons.${snapshot.terminationReason}`)}{" "}
          <span className="font-mono text-text">{snapshot.result}</span>
        </p>
      ) : !snapshot ? (
        <p className="mt-3 text-text-secondary">{t("game.beforeStartHint")}</p>
      ) : null}
      {snapshot?.state === "configuring" ? (
        <p className="mt-3 text-text-secondary">{t("game.configuringHint")}</p>
      ) : null}
      {busy || unfinished ? (
        <div
          className="mt-4 grid min-w-0 grid-cols-[minmax(0,1fr)] text-text-secondary"
          data-testid="status-feedback"
        >
          <div
            className={cx(
              feedbackSlotClassName,
              "group grid grid-cols-[0.5rem_1fr] gap-2 text-accent",
            )}
            data-testid="activity-feedback"
            aria-busy={busy}
            aria-hidden={!busy}
          >
            <span
              className="mt-[0.2rem] h-4 w-[0.4rem] bg-current motion-safe:group-aria-busy:animate-activity-pulse"
              aria-hidden="true"
            />
            <div className="grid">
              {activityKeys.map((key) => (
                <p
                  key={key}
                  className="[grid-area:1/1] aria-hidden:invisible"
                  aria-hidden={activity !== key}
                >
                  {t(key)}
                </p>
              ))}
            </div>
            {snapshot ? (
              <p className="col-start-2 text-label text-text-secondary">{t("game.pendingHint")}</p>
            ) : null}
          </div>
          {unfinished ? (
            <>
              <p
                className={feedbackSlotClassName}
                aria-hidden={busy || state.notice !== null || snapshot.state !== "paused"}
              >
                {t("game.pausedHint")}
              </p>
              {routineNotices.map((notice) => (
                <p
                  key={notice}
                  className={cx(feedbackSlotClassName, noticeClassName)}
                  aria-hidden={busy || state.notice !== notice}
                >
                  {noticeMessage(notice, t)}
                </p>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
      {state.notice && !routineNotice ? (
        <p className={cx("my-4", noticeClassName)}>{noticeMessage(state.notice, t)}</p>
      ) : null}
      {state.phase === "ready" && isRejectionCode(state.notice) ? (
        <p className="mt-3 text-text-secondary">{t("notices.synchronized")}</p>
      ) : null}
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
          aria-disabled={busy}
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
    </section>
  );
}
