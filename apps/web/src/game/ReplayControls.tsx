import { useTranslation } from "react-i18next";

import { Button } from "../ui/Button";

import type { SandboxController, SandboxState } from "./controller";

export function ReplayControls({
  state,
  controller,
}: {
  readonly state: SandboxState;
  readonly controller: SandboxController;
}) {
  const { t } = useTranslation();
  const count = state.replay?.snapshot.moves.length ?? 0;
  const ply = state.replayPly;
  return (
    <section
      className="mt-4 min-w-0 rounded-control border border-control-border bg-surface p-4"
      aria-label={t("replay.title")}
    >
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
            aria-disabled={!state.replay || control.disabled}
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
