import type {
  AiGameConfiguration,
  ChessColor,
  GameSnapshot,
  SessionCredential,
} from "@neurochess/contracts";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import type { AiTurnApi } from "../api/ai";
import type { SandboxApi } from "../api/client";
import { BoardKeyboardHelp } from "../board/BoardKeyboardHelp";
import { Chessboard, type ChessboardHandle } from "../board/Chessboard";
import { announcementMessage, gameStatus } from "../game/messages";
import { MoveHistory } from "../game/panels/MoveHistory";
import { PlaybackControls } from "../game/panels/PlaybackControls";
import { PlayerSummary } from "../game/panels/PlayerSummary";
import { AiPlaybackController } from "../game/playback";
import { interactionEpoch, isTerminal, isUnfinished } from "../game/state";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

import { KeyRecovery } from "./KeyRecovery";

export function GamePreview({
  api,
  turnApi,
  credential,
  onCredential,
  match,
  initial,
  recovered,
  onSetup,
}: {
  readonly api: SandboxApi;
  readonly turnApi: AiTurnApi;
  readonly credential: (color: ChessColor) => SessionCredential | null;
  readonly onCredential?: (color: ChessColor, credential: SessionCredential) => void;
  readonly match: AiGameConfiguration | null;
  readonly initial: GameSnapshot;
  readonly recovered: boolean;
  readonly onSetup: () => void;
}) {
  const { t } = useTranslation();
  const helpId = useId();
  const humanColor = match?.mode === "ai_vs_human" ? match.humanColor : null;
  const board = useRef<ChessboardHandle>(null);
  const [game] = useState(
    () =>
      new AiPlaybackController(api, turnApi, initial, {
        recovered,
        credential,
        isAiGame: match !== null,
        ...(humanColor ? { humanColor } : {}),
      }),
  );
  const activity = useSyncExternalStore(game.subscribe, game.getSnapshot);
  const state = activity.game;
  useEffect(() => game.connect(), [game]);
  useEffect(() => {
    const leave = () => game.leave();
    const offline = () => game.suspend();
    const online = () => {
      game.connect();
    };
    const returnToPage = (event: PageTransitionEvent) => {
      if (event.persisted) game.connect();
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", returnToPage);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", returnToPage);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
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
  const missingKeys = match
    ? (["white", "black"] as const).filter(
        (color) => color !== humanColor && !credential(color)?.apiKey,
      )
    : [];
  const retryingCommand =
    state.phase === "submitting" &&
    activity.control === null &&
    state.announcement?.kind === "notice" &&
    state.announcement.notice === "uncertain";
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
            {(["white", "black"] as const).map((color) => (
              <PlayerSummary
                key={color}
                color={color}
                snapshot={snapshot}
                {...(match.mode === "ai_vs_ai"
                  ? { ai: match[color] }
                  : color !== humanColor
                    ? { ai: match.ai }
                    : {})}
              />
            ))}
          </div>
        ) : null}
        {snapshot ? (
          <Chessboard
            ref={board}
            snapshot={snapshot}
            orientation={humanColor ?? "white"}
            canMove={game.canMove()}
            interactionEpoch={epoch}
            onMove={(move) => {
              void game.submit(move);
            }}
            describedBy={humanColor ? helpId : undefined}
          />
        ) : null}
        {humanColor ? <BoardKeyboardHelp id={helpId} /> : null}
      </section>
      <section aria-label={t("sandbox.gameDetails")} className="min-w-0 space-y-5">
        <h2 className="font-display text-section">
          {t(recovered ? "setup.returned" : "setup.created")}
        </h2>
        <p role="status">{snapshot ? gameStatus(snapshot, t) : t("setup.accessError")}</p>
        <p className="text-text-secondary">
          {humanColor
            ? t("humanPlay.hint", { color: t(`players.${humanColor}`) })
            : t(match ? "playback.hint" : "setup.previewHint")}
        </p>
        {match && !terminal && missingKeys.length > 0 && onCredential ? (
          <KeyRecovery match={match} missing={missingKeys} onCredential={onCredential} />
        ) : null}
        {match && !terminal ? (
          <PlaybackControls
            state={activity}
            controller={game}
            humanColor={humanColor}
            missingKeys={missingKeys.length > 0}
          />
        ) : null}
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
          <div className="flex flex-wrap gap-3">
            <EndGameControl
              key={snapshot.gameId}
              disabled={state.phase !== "ready" || activity.control !== null}
              onConfirm={() => {
                void game.stop();
              }}
            />
            {humanColor ? (
              <EndGameControl
                key={`${snapshot.gameId}-resign`}
                losingColor={humanColor}
                disabled={state.phase !== "ready" || activity.control !== null}
                onConfirm={() => {
                  void game.resign(humanColor);
                }}
              />
            ) : null}
          </div>
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
function EndGameControl({
  disabled,
  losingColor,
  onConfirm,
}: {
  readonly disabled: boolean;
  readonly losingColor?: ChessColor;
  readonly onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const label = losingColor
    ? t(losingColor === "white" ? "lifecycle.resignWhite" : "lifecycle.resignBlack")
    : t("setup.stop");
  return (
    <>
      <Button variant="secondary" aria-disabled={disabled} onClick={() => setConfirming(true)}>
        {label}
      </Button>
      {confirming ? (
        <Dialog
          title={
            losingColor
              ? t("lifecycle.resignTitle", { color: t(`players.${losingColor}`) })
              : t("lifecycle.abortTitle")
          }
          description={
            losingColor
              ? t("lifecycle.resignDescription", {
                  winner: t(losingColor === "white" ? "players.black" : "players.white"),
                })
              : t("lifecycle.abortDescription")
          }
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
                onConfirm();
              }}
            >
              {losingColor ? t("lifecycle.confirmResign") : label}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
