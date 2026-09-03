import { useTranslation } from "react-i18next";

import { noticeMessage } from "../i18n/messages";
import { Button } from "../ui/Button";

import type { SandboxController, SandboxState } from "./controller";

interface Props {
  readonly state: SandboxState;
  readonly controller: SandboxController;
}

const panelClassName = "min-w-0 rounded-control border border-control-border bg-surface p-4";

export function ReplayControls({ state, controller }: Props) {
  const { t } = useTranslation();
  const count = state.replay?.snapshot.moves.length ?? 0;
  const ply = state.replayPly;
  return (
    <section className={"mt-4 " + panelClassName} aria-label={t("replay.title")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-label font-semibold">{t("replay.title")}</h2>
        <span className="text-right text-label text-text-muted">
          {t("replay.position", { ply, count })}
        </span>
      </div>
      {state.replayPhase === "loading" ? <p className="mt-3">{t("replay.loading")}</p> : null}
      <div className="mt-4 grid grid-cols-2 gap-3">
        {(
          [
            { key: "first", target: 0, disabled: ply === 0 },
            { key: "previous", target: ply - 1, disabled: ply === 0 },
            { key: "next", target: ply + 1, disabled: ply === count },
            { key: "last", target: count, disabled: ply === count },
          ] as const
        ).map((control) => (
          <Button
            key={control.key}
            variant="secondary"
            disabled={!state.replay || control.disabled}
            onClick={() => controller.selectPly(control.target)}
          >
            {t(`replay.${control.key}`)}
          </Button>
        ))}
      </div>
      {state.replayPhase === "error" ? (
        <Button
          variant="secondary"
          onClick={() => {
            void controller.loadReplay();
          }}
        >
          {t("replay.retry")}
        </Button>
      ) : null}
    </section>
  );
}

export function PgnActions({ state, controller }: Props) {
  const { t } = useTranslation();
  return (
    <section className={panelClassName} aria-labelledby="pgn-heading">
      <h2 id="pgn-heading" className="text-label font-semibold">
        {t("export.title")}
      </h2>
      <div className="my-4 flex flex-wrap gap-3">
        <Button
          variant="secondary"
          className="flex-[1_1_8rem]"
          disabled={state.exportPhase === "loading"}
          onClick={() => {
            void controller.exportPgn("copy");
          }}
        >
          {t("export.copy")}
        </Button>
        <Button
          variant="secondary"
          className="flex-[1_1_8rem]"
          disabled={state.exportPhase === "loading"}
          onClick={() => {
            void controller.exportPgn("download");
          }}
        >
          {t("export.download")}
        </Button>
      </div>
      {state.exportPhase !== "idle" && state.exportPhase !== "error" ? (
        <p className="mt-3">{t(`export.${state.exportPhase}`)}</p>
      ) : null}
      {state.archiveNotice ? <p className="mt-3">{noticeMessage(state.archiveNotice, t)}</p> : null}
      {state.exportText ? (
        <label className="mt-3 grid gap-2">
          {t("export.text")}
          <textarea
            className="min-h-32 w-full resize-y rounded-control border border-control-border bg-canvas p-3 text-text"
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
