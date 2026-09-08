import type { ChessColor } from "@neurochess/contracts";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../ui/Button";
import { StableText } from "../../ui/StableText";
import { providerFailure } from "../ai-feedback";
import type { AiPlaybackController, PlaybackState } from "../playback";

export function PlaybackControls({
  state,
  controller,
  humanColor = null,
  missingKeys = false,
}: {
  readonly state: PlaybackState;
  readonly controller: AiPlaybackController;
  readonly humanColor?: ChessColor | null;
  readonly missingKeys?: boolean;
}) {
  const { t } = useTranslation();
  const speedId = useId();
  const disabled = state.game.phase !== "ready" || state.control !== null;
  const pause = state.automatic || state.activity !== "idle";
  const retry = providerFailure(state.game.snapshot) !== null;
  const hasProviderFailure = state.game.snapshot?.invocations?.some(
    ({ status }) => status === "provider_error",
  );
  const status = state.control
    ? t("playback.applying")
    : humanColor && state.game.phase === "submitting"
      ? t("move" in state.game.pendingCommand ? "humanPlay.submitting" : "playback.applying")
      : humanColor && state.game.phase === "synchronizing"
        ? t("playback.synchronizing")
        : state.activity === "thinking"
          ? state.retry > 0
            ? t("playback.retrying", { retry: state.retry })
            : t("playback.thinking", {
                color: t(state.game.snapshot?.turn === "black" ? "players.black" : "players.white"),
              })
          : state.activity === "synchronizing"
            ? t("playback.synchronizing")
            : state.activity === "uncertain"
              ? t("playback.uncertain")
              : humanColor && !state.automatic
                ? t("humanPlay.idle")
                : humanColor && state.game.snapshot?.turn === humanColor
                  ? t("humanPlay.yourTurn")
                  : t(state.automatic ? "playback.pacing" : "playback.idle");
  return (
    <div
      className="space-y-4"
      role="group"
      aria-label={t(humanColor ? "humanPlay.controls" : "playback.controls")}
    >
      <p
        role="status"
        aria-atomic="true"
        className={state.retry > 0 ? "text-warning" : "text-text-secondary"}
      >
        <StableText
          value={status}
          variants={[
            t("playback.thinking", { color: t("players.white") }),
            t("playback.thinking", { color: t("players.black") }),
            t("playback.retrying", { retry: 1 }),
            t("playback.retrying", { retry: 2 }),
            t("playback.pacing"),
            t("playback.idle"),
            t("playback.applying"),
            ...(humanColor
              ? [t("humanPlay.yourTurn"), t("humanPlay.submitting"), t("humanPlay.idle")]
              : []),
          ]}
        />
      </p>
      <div className={humanColor ? "grid gap-3" : "grid grid-cols-2 gap-3"}>
        <Button
          variant="primary"
          aria-disabled={disabled || (!pause && missingKeys)}
          onClick={() => {
            void (pause ? controller.pause() : controller.resume());
          }}
        >
          <StableText
            value={t(pause ? "lifecycle.pause" : "lifecycle.resume")}
            variants={[t("lifecycle.pause"), t("lifecycle.resume")]}
            align="center"
          />
        </Button>
        {!humanColor || (hasProviderFailure && state.game.snapshot?.state === "paused") ? (
          <Button
            variant="secondary"
            aria-disabled={
              disabled ||
              missingKeys ||
              (Boolean(humanColor) && !retry) ||
              state.activity !== "idle" ||
              state.game.snapshot.state !== "paused"
            }
            onClick={() => {
              void controller.next();
            }}
          >
            <StableText
              value={t(retry || humanColor ? "playback.retry" : "playback.next")}
              variants={[t("playback.retry"), t("playback.next")]}
              align="center"
            />
          </Button>
        ) : null}
      </div>
      {state.activity === "uncertain" ? (
        <Button
          variant="secondary"
          aria-disabled={disabled}
          onClick={() => {
            void controller.synchronize();
          }}
        >
          {t("playback.synchronize")}
        </Button>
      ) : null}
      {!humanColor ? (
        <>
          <label htmlFor={speedId} className="block text-label font-semibold">
            {t("playback.speed")}
          </label>
          <select
            id={speedId}
            value={state.speed}
            aria-describedby={`${speedId}-hint`}
            className="min-h-target w-full rounded-control border border-control-border bg-surface px-3 text-body"
            onChange={(event) => {
              const speed = Number(event.target.value);
              if (speed === 0.5 || speed === 1 || speed === 2) controller.setSpeed(speed);
            }}
          >
            <option value={0.5}>{t("playback.slow")}</option>
            <option value={1}>{t("playback.normal")}</option>
            <option value={2}>{t("playback.fast")}</option>
          </select>
          <p id={`${speedId}-hint`} className="text-label text-text-muted">
            {t("playback.speedHint")}
          </p>
        </>
      ) : null}
    </div>
  );
}
