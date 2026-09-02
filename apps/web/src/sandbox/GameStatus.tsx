import { useTranslation } from "react-i18next";

import { gameStatus, noticeMessage, resultTitle } from "../i18n/messages";

import type { SandboxController, SandboxState } from "./controller";
import { LifecycleControls } from "./LifecycleControls";
import { StableText } from "./StableText";

const activityMessages = [
  { phase: "starting", key: "actions.starting" },
  { phase: "submitting", key: "game.submitting" },
  { phase: "submitting", key: "lifecycle.submitting" },
  { phase: "synchronizing", key: "game.synchronizing" },
  { phase: "recovering", key: "game.recovering" },
] as const;

// Routine notices replace the paused hint in the same reserved feedback slot.
// Errors and their recovery actions can grow naturally; never clip their details.
const routineNotices = ["existing", "recovered", "synchronized"] as const;

export function GameStatus({
  state,
  controller,
}: {
  readonly state: SandboxState;
  readonly controller: SandboxController;
}) {
  const { t } = useTranslation();
  const { snapshot } = state;
  const unfinished = snapshot?.state === "active" || snapshot?.state === "paused";
  const activityKey =
    state.phase === "submitting"
      ? state.pendingCommand && "action" in state.pendingCommand
        ? "lifecycle.submitting"
        : "game.submitting"
      : activityMessages.find(({ phase }) => phase === state.phase)?.key;
  const busy = activityKey !== undefined;
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
    <section className="game-status" aria-labelledby="status-heading">
      <div className="section-heading">
        <p className="eyebrow">{t("game.status")}</p>
        {snapshot ? (
          <span className={"lifecycle lifecycle--" + snapshot.state}>
            <StableText
              value={t(`game.${snapshot.state}`)}
              variants={unfinished ? [t("game.active"), t("game.paused")] : []}
            />
          </span>
        ) : null}
      </div>
      <h2 id="status-heading">
        <StableText value={title} variants={titleVariants} />
      </h2>
      {snapshot?.terminationReason ? (
        <p className="result-detail">
          {t(`reasons.${snapshot.terminationReason}`)}{" "}
          <span className="result-score">{snapshot.result}</span>
        </p>
      ) : !snapshot ? (
        <p>{t("game.beforeStartHint")}</p>
      ) : null}
      {snapshot?.state === "configuring" ? <p>{t("game.configuringHint")}</p> : null}
      {busy || unfinished ? (
        <div className="status-feedback">
          <div className="activity-feedback" aria-busy={busy} aria-hidden={!busy}>
            <span className="activity-feedback__mark" aria-hidden="true" />
            <div className="activity-feedback__messages">
              {activityMessages.map(({ key }) => (
                <p key={key} aria-hidden={activityKey !== key}>
                  {t(key)}
                </p>
              ))}
            </div>
            {snapshot ? <p className="activity-feedback__hint">{t("game.pendingHint")}</p> : null}
          </div>
          {unfinished ? (
            <>
              <p aria-hidden={busy || state.notice !== null || snapshot.state !== "paused"}>
                {t("game.pausedHint")}
              </p>
              {routineNotices.map((notice) => (
                <p key={notice} className="notice" aria-hidden={busy || state.notice !== notice}>
                  {noticeMessage(notice, t)}
                </p>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
      {state.notice && !routineNotice ? (
        <p className="notice">{noticeMessage(state.notice, t)}</p>
      ) : null}
      {state.phase === "ready" &&
      state.notice &&
      ["INVALID_REQUEST", "INVALID_UCI", "ILLEGAL_MOVE", "INVALID_GAME_STATE"].includes(
        state.notice,
      ) ? (
        <p>{t("notices.synchronized")}</p>
      ) : null}
      {state.phase === "uncertain" || state.phase === "sync-required" ? (
        <div className="recovery-actions">
          <p>{t("game.uncertainHint")}</p>
          {state.phase === "uncertain" ? (
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                void controller.retryMove();
              }}
            >
              {t(
                state.pendingCommand && "action" in state.pendingCommand
                  ? "actions.retryCommand"
                  : "actions.retryMove",
              )}
            </button>
          ) : null}
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              void controller.synchronize();
            }}
          >
            {t("actions.synchronize")}
          </button>
        </div>
      ) : null}
      {state.phase === "recovery-required" ? (
        <button
          type="button"
          className="button button--primary"
          onClick={() => {
            void controller.recover();
          }}
        >
          {t("actions.retryRecovery")}
        </button>
      ) : null}
      {unfinished ? (
        <LifecycleControls key={snapshot.gameId} state={state} controller={controller} />
      ) : null}
      {snapshot && ["completed", "aborted"].includes(snapshot.state) ? (
        <button
          type="button"
          className="button button--primary new-game"
          disabled={busy}
          onClick={() => {
            void controller.start();
          }}
        >
          {t("actions.newGame")}
        </button>
      ) : null}
      {state.readiness === "unavailable" ? (
        <button
          type="button"
          className="button button--secondary"
          onClick={() => {
            void controller.checkReadiness();
          }}
        >
          {t("actions.retryConnection")}
        </button>
      ) : null}
    </section>
  );
}
