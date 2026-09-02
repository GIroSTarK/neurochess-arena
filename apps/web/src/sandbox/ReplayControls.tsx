import { useTranslation } from "react-i18next";

import { noticeMessage } from "../i18n/messages";

import type { SandboxController, SandboxState } from "./controller";

interface Props {
  readonly state: SandboxState;
  readonly controller: SandboxController;
}

export function ReplayControls({ state, controller }: Props) {
  const { t } = useTranslation();
  const count = state.replay?.snapshot.moves.length ?? 0;
  const ply = state.replayPly;
  return (
    <section className="replay-controls" aria-label={t("replay.title")}>
      <div className="section-heading">
        <h2>{t("replay.title")}</h2>
        <span>{t("replay.position", { ply, count })}</span>
      </div>
      {state.replayPhase === "loading" ? <p>{t("replay.loading")}</p> : null}
      <div className="replay-buttons">
        {(
          [
            { key: "first", target: 0, disabled: ply === 0 },
            { key: "previous", target: ply - 1, disabled: ply === 0 },
            { key: "next", target: ply + 1, disabled: ply === count },
            { key: "last", target: count, disabled: ply === count },
          ] as const
        ).map((control) => (
          <button
            key={control.key}
            type="button"
            className="button button--secondary"
            disabled={!state.replay || control.disabled}
            onClick={() => controller.selectPly(control.target)}
          >
            {t(`replay.${control.key}`)}
          </button>
        ))}
      </div>
      {state.replayPhase === "error" ? (
        <button
          type="button"
          className="button button--secondary"
          onClick={() => {
            void controller.loadReplay();
          }}
        >
          {t("replay.retry")}
        </button>
      ) : null}
    </section>
  );
}

export function PgnActions({ state, controller }: Props) {
  const { t } = useTranslation();
  return (
    <section className="pgn-actions" aria-labelledby="pgn-heading">
      <h2 id="pgn-heading">{t("export.title")}</h2>
      <div className="dialog-actions">
        <button
          type="button"
          className="button button--secondary"
          disabled={state.exportPhase === "loading"}
          onClick={() => {
            void controller.exportPgn("copy");
          }}
        >
          {t("export.copy")}
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={state.exportPhase === "loading"}
          onClick={() => {
            void controller.exportPgn("download");
          }}
        >
          {t("export.download")}
        </button>
      </div>
      {state.exportPhase !== "idle" && state.exportPhase !== "error" ? (
        <p>{t(`export.${state.exportPhase}`)}</p>
      ) : null}
      {state.archiveNotice ? (
        <p className="notice">{noticeMessage(state.archiveNotice, t)}</p>
      ) : null}
      {state.exportText ? (
        <label className="pgn-label">
          {t("export.text")}
          <textarea
            className="pgn-text"
            readOnly
            rows={8}
            value={state.exportText}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      ) : null}
    </section>
  );
}
