import type {
  ChessColor,
  CreateAiGameRequest,
  GameSnapshot,
  SessionCredential,
} from "@neurochess/contracts";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import type { AiTurnApi } from "../api/ai";
import type { SandboxApi } from "../api/client";
import { Chessboard, type ChessboardHandle } from "../board/Chessboard";
import { announcementMessage, gameStatus } from "../game/messages";
import { MoveHistory } from "../game/panels/MoveHistory";
import { PlaybackControls } from "../game/panels/PlaybackControls";
import { PlayerSummary } from "../game/panels/PlayerSummary";
import { AiPlaybackController } from "../game/playback";
import { interactionEpoch, isTerminal, isUnfinished } from "../game/state";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

export function GamePreview({
  api,
  turnApi,
  credential,
  match,
  initial,
  recovered,
  orientation,
  onSetup,
}: {
  readonly api: SandboxApi;
  readonly turnApi: AiTurnApi;
  readonly credential: (color: ChessColor) => SessionCredential | null;
  readonly match: Extract<CreateAiGameRequest, { mode: "ai_vs_ai" }> | null;
  readonly initial: GameSnapshot;
  readonly recovered: boolean;
  readonly orientation: ChessColor;
  readonly onSetup: () => void;
}) {
  const { t } = useTranslation();
  const board = useRef<ChessboardHandle>(null);
  const [game] = useState(
    () => new AiPlaybackController(api, turnApi, initial, { recovered, credential }),
  );
  const activity = useSyncExternalStore(game.subscribe, game.getSnapshot);
  const state = activity.game;
  useEffect(() => game.connect(), [game]);
  useEffect(() => {
    const leave = () => game.disconnect();
    const returnToPage = (event: PageTransitionEvent) => {
      game.connect();
      if (event.persisted) void game.recover();
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", returnToPage);
    return () => {
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", returnToPage);
    };
  }, [game]);
  useLayoutEffect(() => {
    if (!recovered && (!document.activeElement || document.activeElement === document.body)) {
      board.current?.focus();
    }
  }, [recovered]);
  const snapshot = state.snapshot;
  const epoch = interactionEpoch(state);
  const terminal = snapshot && isTerminal(snapshot);
  const retryingCommand = state.phase === "submitting" && activity.control === null;
  const showRecovery = state.phase !== "ready" && (state.phase !== "submitting" || retryingCommand);
  if (state.phase === "access-error") {
    return (
      <section
        aria-label={t("sandbox.gameDetails")}
        className="space-y-4 rounded-panel border border-warning bg-surface p-6"
      >
        <p role="alert">{t("setup.accessError")}</p>
        <Button variant="primary" onClick={onSetup}>
          {t("setup.returnSetup")}
        </Button>
      </section>
    );
  }
  return (
    <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,640px)_minmax(0,1fr)]">
      <section aria-label={t("sandbox.playArea")}>
        {match ? (
          <div className="mb-4 grid grid-cols-2 rounded-panel border border-divider bg-surface">
            <PlayerSummary color="white" snapshot={snapshot} ai={match.white} />
            <PlayerSummary color="black" snapshot={snapshot} ai={match.black} />
          </div>
        ) : null}
        {snapshot ? (
          <Chessboard
            ref={board}
            snapshot={snapshot}
            orientation={orientation}
            canMove={false}
            interactionEpoch={epoch}
            onMove={() => undefined}
          />
        ) : null}
      </section>
      <section aria-label={t("sandbox.gameDetails")} className="min-w-0 space-y-5">
        <h2 className="font-display text-section">
          {t(recovered ? "setup.returned" : "setup.created")}
        </h2>
        <p role="status">{snapshot ? gameStatus(snapshot, t) : t("setup.accessError")}</p>
        <p className="text-text-secondary">{t(match ? "playback.hint" : "setup.previewHint")}</p>
        {recovered ? <p className="text-label text-warning">{t("setup.recoveredHint")}</p> : null}
        {match && !terminal ? <PlaybackControls state={activity} controller={game} /> : null}
        {showRecovery ? (
          <div role="status" className="space-y-3">
            <p>{t("setup.checkGame")}</p>
            <Button
              variant="secondary"
              aria-disabled={
                state.phase === "recovering" ||
                state.phase === "submitting" ||
                state.phase === "synchronizing"
              }
              onClick={() => {
                void (state.phase === "uncertain"
                  ? game.retryCommand()
                  : state.phase === "sync-required"
                    ? game.synchronize()
                    : game.recover());
              }}
            >
              {t(
                state.phase === "uncertain" || retryingCommand
                  ? "actions.retryCommand"
                  : "actions.retryRecovery",
              )}
            </Button>
          </div>
        ) : null}
        {terminal ? (
          <Button variant="primary" onClick={onSetup}>
            {t("setup.newMatch")}
          </Button>
        ) : snapshot && isUnfinished(snapshot) ? (
          <StopControl
            key={snapshot.gameId}
            disabled={state.phase !== "ready" || activity.control !== null}
            onStop={() => {
              void game.stop();
            }}
          />
        ) : null}
        <MoveHistory moves={snapshot?.moves ?? []} />
      </section>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcementMessage(state.announcement, t)}
      </div>
    </div>
  );
}

/** Mounted for one unfinished game so accepted moves preserve the dialog and its focus. */
function StopControl({
  disabled,
  onStop,
}: {
  readonly disabled: boolean;
  readonly onStop: () => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Button variant="secondary" aria-disabled={disabled} onClick={() => setConfirming(true)}>
        {t("setup.stop")}
      </Button>
      {confirming ? (
        <Dialog
          title={t("lifecycle.abortTitle")}
          description={t("lifecycle.abortDescription")}
          onCancel={() => setConfirming(false)}
        >
          {disabled ? (
            <p role="status" className="mt-3 text-text-secondary">
              {t("setup.checkGame")}
            </p>
          ) : null}
          <div className="my-4 flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {t("actions.cancel")}
            </Button>
            <Button
              variant="danger"
              aria-disabled={disabled}
              onClick={() => {
                setConfirming(false);
                onStop();
              }}
            >
              {t("setup.stop")}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
