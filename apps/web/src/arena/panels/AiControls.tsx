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
}) {
  const { t } = useTranslation();
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const confirming = confirmation === epoch && !busy;
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
        <Button variant="quiet-danger" aria-disabled={busy} onClick={() => setConfirmation(epoch)}>
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
          title={t("match.stopTitle")}
          description={t("match.stopDescription")}
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
                onStop();
              }}
            >
              {t("match.confirmStop")}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
