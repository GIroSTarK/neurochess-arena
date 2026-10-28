import type { ChessColor } from "@neurochess/contracts";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { resignationConfirmation } from "../../arena/resignation";
import { Button } from "../../ui/button";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { StableText } from "../../ui/stable-text";

export function AiControls({
  paused,
  busy,
  canContinue,
  canStep,
  epoch,
  onPause,
  onResume,
  onStep,
  onStop,
  resignation,
}: {
  readonly paused: boolean;
  readonly busy: boolean;
  readonly canContinue: boolean;
  readonly canStep: boolean;
  readonly epoch: string;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onStep: () => void;
  readonly onStop: () => void;
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
      {confirming ? (
        <ConfirmDialog
          {...(resigning && resignation
            ? resignationConfirmation(resignation.color, t)
            : {
                title: t("match.stopTitle"),
                description: t("match.stopDescription"),
                confirmLabel: t("match.confirmStop"),
              })}
          cancelLabel={t("actions.cancel")}
          actionsClassName="my-4 flex flex-wrap gap-3"
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            setConfirmation(null);
            if (resigning) resignation?.onResign();
            else onStop();
          }}
        />
      ) : null}
    </section>
  );
}
