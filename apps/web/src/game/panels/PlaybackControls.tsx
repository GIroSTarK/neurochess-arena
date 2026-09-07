import { useId } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../ui/Button";
import { StableText } from "../../ui/StableText";
import type { AiPlaybackController, PlaybackState } from "../playback";

export function PlaybackControls({
  state,
  controller,
}: {
  readonly state: PlaybackState;
  readonly controller: AiPlaybackController;
}) {
  const { t } = useTranslation();
  const speedId = useId();
  const disabled = state.game.phase !== "ready" || state.control !== null;
  const pause = state.automatic || state.activity !== "idle";
  const status = state.control
    ? t("playback.applying")
    : state.activity === "thinking"
      ? t("playback.thinking", {
          color: t(state.game.snapshot?.turn === "black" ? "players.black" : "players.white"),
        })
      : state.activity === "synchronizing"
        ? t("playback.synchronizing")
        : state.activity === "uncertain"
          ? t("playback.uncertain")
          : t(state.automatic ? "playback.pacing" : "playback.idle");
  return (
    <div className="space-y-4" role="group" aria-label={t("playback.controls")}>
      <p role="status" className="text-text-secondary">
        <StableText
          value={status}
          variants={[
            t("playback.thinking", { color: t("players.white") }),
            t("playback.thinking", { color: t("players.black") }),
            t("playback.pacing"),
            t("playback.idle"),
            t("playback.applying"),
          ]}
        />
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Button
          variant="primary"
          aria-disabled={disabled}
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
        <Button
          variant="secondary"
          aria-disabled={
            disabled || state.activity !== "idle" || state.game.snapshot.state !== "paused"
          }
          onClick={() => {
            void controller.next();
          }}
        >
          {t("playback.next")}
        </Button>
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
    </div>
  );
}
