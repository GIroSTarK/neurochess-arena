import type { ChessColor, GameSnapshot } from "@neurochess/contracts";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Chessboard } from "./board/Chessboard";
import { PieceIcon } from "./board/PieceIcon";
import { DocumentMetadata } from "./DocumentMetadata";
import { announcementMessage, gameStatus, noticeMessage, resultTitle } from "./i18n/messages";
import { MoveHistory } from "./sandbox/MoveHistory";
import type { SandboxController, SandboxState } from "./sandbox/controller";
import { useSandbox } from "./sandbox/use-sandbox";

export interface AppProps {
  readonly apiBaseUrl: string;
}

export function App({ apiBaseUrl }: AppProps) {
  const { t } = useTranslation();
  const { state, controller } = useSandbox(apiBaseUrl);
  const [orientation, setOrientation] = useState<ChessColor>("white");
  const { snapshot } = state;
  const busy = ["starting", "submitting", "synchronizing"].includes(state.phase);

  return (
    <div className="app-shell">
      <DocumentMetadata />
      <a className="skip-link" href="#sandbox">
        {t("app.skipLink")}
      </a>
      <header className="app-header">
        <p className="wordmark">
          <span>{t("app.brand")}</span> <span>{t("app.arena")}</span>
        </p>
        <span className="environment-label">{t("app.localDevelopment")}</span>
      </header>
      <main id="sandbox" tabIndex={-1}>
        <div className="page-heading">
          <div>
            <h1>{t("sandbox.title")}</h1>
            <p>{t("sandbox.description")}</p>
          </div>
          <div
            className={"connection connection--" + state.readiness}
            aria-label={t("connection.label")}
          >
            <span className="connection__mark" aria-hidden="true">
              {state.readiness === "ready" ? "✓" : state.readiness === "checking" ? "…" : "!"}
            </span>
            <span>{t(`connection.${state.readiness}`)}</span>
          </div>
        </div>
        <div className="arena-frame">
          <section className="board-panel" aria-label={t("board.label")}>
            <div className="player-summaries">
              <PlayerSummary color="white" snapshot={snapshot} />
              <PlayerSummary color="black" snapshot={snapshot} />
            </div>
            {snapshot ? (
              <>
                <Chessboard
                  snapshot={snapshot}
                  orientation={orientation}
                  canMove={state.phase === "ready"}
                  interactionRevision={state.interactionRevision}
                  onMove={(move) => {
                    void controller.submit(move);
                  }}
                  toolbar={
                    <div className="board-toolbar">
                      <button
                        type="button"
                        className="button button--secondary"
                        onClick={() =>
                          setOrientation((previous) => (previous === "white" ? "black" : "white"))
                        }
                      >
                        <svg viewBox="0 0 24 24" className="icon" aria-hidden="true">
                          <path d="M4 8h16m-4-4 4 4-4 4M20 16H4m4-4-4 4 4 4" />
                        </svg>
                        {t("actions.flip")}
                      </button>
                      <span>
                        {t(orientation === "white" ? "board.whiteBottom" : "board.blackBottom")}
                      </span>
                    </div>
                  }
                />
              </>
            ) : (
              <div className="sandbox-entry">
                <div className="sandbox-entry__content">
                  <div className="sandbox-entry__piece">
                    <PieceIcon color="white" kind="n" />
                  </div>
                  <h2>{t("sandbox.entryTitle")}</h2>
                  <p>{t("sandbox.entryDescription")}</p>
                  <StartButton state={state} controller={controller} />
                </div>
              </div>
            )}
          </section>
          <aside className="information-rail" aria-label={t("game.status")}>
            <section className="game-status" aria-labelledby="status-heading">
              <div className="section-heading">
                <p className="eyebrow">{t("game.status")}</p>
                {snapshot ? (
                  <span className={"lifecycle lifecycle--" + snapshot.state}>
                    {t(`game.${snapshot.state}`)}
                  </span>
                ) : null}
              </div>
              <h2 id="status-heading">
                {snapshot
                  ? snapshot.terminationReason
                    ? resultTitle(snapshot, t)
                    : gameStatus(snapshot, t)
                  : t("game.beforeStart")}
              </h2>
              {snapshot?.terminationReason ? (
                <p className="result-detail">
                  {t(`reasons.${snapshot.terminationReason}`)}{" "}
                  <span className="result-score">{snapshot.result}</span>
                </p>
              ) : !snapshot ? (
                <p>{t("game.beforeStartHint")}</p>
              ) : null}
              {snapshot?.state === "paused" ? <p>{t("game.pausedHint")}</p> : null}
              {snapshot?.state === "configuring" ? <p>{t("game.configuringHint")}</p> : null}
              {busy ? (
                <div className="activity-feedback" aria-busy="true">
                  <span className="activity-feedback__mark" aria-hidden="true" />
                  <p>
                    {t(
                      state.phase === "starting"
                        ? "actions.starting"
                        : state.phase === "submitting"
                          ? "game.submitting"
                          : "game.synchronizing",
                    )}
                  </p>
                  {snapshot ? (
                    <p className="activity-feedback__hint">{t("game.pendingHint")}</p>
                  ) : null}
                </div>
              ) : null}
              {state.notice ? <p className="notice">{noticeMessage(state.notice, t)}</p> : null}
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
                      {t("actions.retryMove")}
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
            <MoveHistory moves={snapshot?.moves ?? []} />
            <div className="session-note">
              <span className="session-note__title">
                <svg viewBox="0 0 24 24" className="icon" aria-hidden="true">
                  <path d="M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3" />
                </svg>
                {t("sandbox.privacy")}
              </span>
              <p>{t("sandbox.memoryHint")}</p>
            </div>
          </aside>
        </div>
      </main>
      <footer className="app-footer">{t("sandbox.footer")}</footer>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcementMessage(state.announcement, t)}
      </div>
    </div>
  );
}

function PlayerSummary({
  color,
  snapshot,
}: {
  readonly color: ChessColor;
  readonly snapshot: GameSnapshot | null;
}) {
  const { t } = useTranslation();
  const isTurn = snapshot?.state === "active" && snapshot.turn === color;
  return (
    <div
      className="player-summary"
      data-turn={isTurn || undefined}
      aria-label={t("players.label", { color: t(`players.${color}`) })}
    >
      <PieceIcon color={color} kind="k" />
      <div className="player-summary__copy">
        <span className="player-summary__color">{t(`players.${color}`)}</span>
        <strong>{t("players.guest")}</strong>
        <span className="player-summary__activity">
          {t(
            !snapshot
              ? "players.ready"
              : snapshot.state !== "active"
                ? "players.inspecting"
                : isTurn
                  ? "players.toMove"
                  : "players.waiting",
          )}
        </span>
      </div>
    </div>
  );
}

function StartButton({
  state,
  controller,
}: {
  readonly state: SandboxState;
  readonly controller: SandboxController;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="button button--primary"
      disabled={state.readiness !== "ready" || state.phase === "starting"}
      onClick={() => {
        void controller.start();
      }}
    >
      {t(
        state.phase === "starting"
          ? "actions.starting"
          : state.phase === "unavailable"
            ? "actions.retryStart"
            : state.phase === "access-error"
              ? "actions.restartSession"
              : "actions.start",
      )}
      <svg viewBox="0 0 24 24" className="icon" aria-hidden="true">
        <path d="M5 12h14m-6-6 6 6-6 6" />
      </svg>
    </button>
  );
}
