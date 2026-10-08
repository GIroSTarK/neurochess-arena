import type { ChessColor } from "@neurochess/contracts";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Select } from "../../ui/Select";
import { StableText } from "../../ui/StableText";

export function AiControls({
  paused,
  busy,
  canContinue,
  canStep,
  epoch,
  speed,
  onPause,
  onResume,
  onStep,
  onStop,
  onSpeed,
  resignation,
}: {
  readonly paused: boolean;
  readonly busy: boolean;
  readonly canContinue: boolean;
  readonly canStep: boolean;
  readonly epoch: string;
  readonly speed: number;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onStep: () => void;
  readonly onStop: () => void;
  readonly onSpeed: (speed: number) => void;
  readonly resignation?: { color: ChessColor; disabled: boolean; onResign: () => void } | undefined;
}) {
  const { t } = useTranslation();
  const [confirmation, setConfirmation] = useState<{
    epoch: string;
    action: "stop" | "resign";
  } | null>(null);
  const resigning = confirmation?.action === "resign";
  const confirming =
    confirmation?.epoch === epoch &&
    !busy &&
    (!resigning || (resignation && !resignation.disabled));
  if (confirmation !== null && !confirming) setConfirmation(null);
  return (
    <section aria-label={t("lifecycle.controls")} className="mt-4 grid gap-3">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-2">
        <Button
          variant="primary"
          aria-disabled={busy || (paused && !canContinue)}
          onClick={paused ? onResume : onPause}
        >
          <StableText
            value={t(paused ? "lifecycle.resume" : "lifecycle.pause")}
            variants={[t("lifecycle.pause"), t("lifecycle.resume")]}
            align="center"
          />
        </Button>
        <Button variant="secondary" aria-disabled={!canStep || busy} onClick={onStep}>
          {t("match.next")}
        </Button>
        {resignation ? (
          <Button
            variant="quiet"
            aria-disabled={busy || resignation.disabled}
            onClick={() => setConfirmation({ epoch, action: "resign" })}
          >
            {t(resignation.color === "white" ? "lifecycle.resignWhite" : "lifecycle.resignBlack")}
          </Button>
        ) : null}
        <Button
          variant="quiet-danger"
          aria-disabled={busy}
          onClick={() => setConfirmation({ epoch, action: "stop" })}
        >
          {t("match.stop")}
        </Button>
      </div>
      <label className="grid min-w-0 gap-2 text-label sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
        {t("match.speed")}
        <Select value={speed} onChange={(event) => onSpeed(Number(event.target.value))}>
          <option value={500}>{t("match.fast")}</option>
          <option value={1500}>{t("match.normal")}</option>
          <option value={5000}>{t("match.slow")}</option>
        </Select>
      </label>
      {confirming ? (
        <Dialog
          title={
            resigning && resignation
              ? t("lifecycle.resignTitle", { color: t(`players.${resignation.color}`) })
              : t("match.stopTitle")
          }
          description={
            resigning && resignation
              ? t("lifecycle.resignDescription", {
                  winner: t(resignation.color === "white" ? "players.black" : "players.white"),
                })
              : t("match.stopDescription")
          }
          onCancel={() => setConfirmation(null)}
        >
          <div className="my-4 flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => setConfirmation(null)}>
              {t("actions.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmation(null);
                if (resigning) resignation?.onResign();
                else onStop();
              }}
            >
              {t(resigning ? "lifecycle.confirmResign" : "match.confirmStop")}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
