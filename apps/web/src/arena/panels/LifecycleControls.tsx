import type { ChessColor } from "@neurochess/contracts";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { StableText } from "../../ui/StableText";

type Confirmation = { action: "abort" } | { action: "resign"; losingColor: ChessColor };

interface PendingConfirmation {
  readonly epoch: string;
  readonly action: Confirmation;
}

export interface LifecycleControlsProps {
  readonly paused: boolean;
  readonly disabled: boolean;
  readonly epoch: string;
  readonly onTogglePause?: (() => void) | undefined;
  readonly onAbort?: (() => void) | undefined;
  readonly resignations: readonly {
    readonly color: ChessColor;
    readonly onResign: () => void;
  }[];
}

export function LifecycleControls({
  paused,
  disabled,
  epoch,
  onTogglePause,
  onAbort,
  resignations,
}: LifecycleControlsProps) {
  const { t } = useTranslation();
  const [pendingConfirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const pending = pendingConfirmation?.action;
  const confirmedAction =
    pending?.action === "abort"
      ? onAbort
      : resignations.find((seat) => seat.color === pending?.losingColor)?.onResign;
  // A revision or capability change invalidates confirmation without replacing its trigger.
  const confirmation =
    !disabled && pendingConfirmation?.epoch === epoch && confirmedAction
      ? pendingConfirmation.action
      : null;
  if (pendingConfirmation !== null && confirmation === null) {
    setConfirmation(null);
  }

  function confirm(action: Confirmation) {
    if (!disabled) setConfirmation({ epoch, action });
  }

  return (
    <div className="mt-4 grid grid-cols-2 gap-3" aria-label={t("lifecycle.controls")} role="group">
      {onTogglePause ? (
        <Button
          variant="primary"
          aria-disabled={disabled}
          onClick={() => {
            if (!disabled) onTogglePause();
          }}
        >
          <StableText
            value={t(paused ? "lifecycle.resume" : "lifecycle.pause")}
            variants={[t("lifecycle.pause"), t("lifecycle.resume")]}
            align="center"
          />
        </Button>
      ) : null}
      {onAbort ? (
        <Button
          variant="secondary"
          aria-disabled={disabled}
          onClick={() => confirm({ action: "abort" })}
        >
          {t("lifecycle.abort")}
        </Button>
      ) : null}
      {resignations.map(({ color }) => (
        <Button
          key={color}
          variant="secondary"
          aria-disabled={disabled}
          onClick={() => confirm({ action: "resign", losingColor: color })}
        >
          {t(color === "white" ? "lifecycle.resignWhite" : "lifecycle.resignBlack")}
        </Button>
      ))}
      {confirmation ? (
        <ConfirmationDialog
          action={confirmation}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            setConfirmation(null);
            if (!disabled) confirmedAction?.();
          }}
        />
      ) : null}
    </div>
  );
}

/** Destructive confirmation: Cancel comes first so it receives the initial focus. */
function ConfirmationDialog({
  action,
  onCancel,
  onConfirm,
}: {
  readonly action: Confirmation;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={
        action.action === "abort"
          ? t("lifecycle.abortTitle")
          : t("lifecycle.resignTitle", { color: t(`players.${action.losingColor}`) })
      }
      description={
        action.action === "abort"
          ? t("lifecycle.abortDescription")
          : t("lifecycle.resignDescription", {
              winner: t(action.losingColor === "white" ? "players.black" : "players.white"),
            })
      }
      onCancel={onCancel}
    >
      <div className="my-4 flex flex-wrap gap-3">
        <Button variant="secondary" className="flex-[1_1_8rem]" onClick={onCancel}>
          {t("actions.cancel")}
        </Button>
        <Button variant="danger" className="flex-[1_1_8rem]" onClick={onConfirm}>
          {t(action.action === "abort" ? "lifecycle.confirmAbort" : "lifecycle.confirmResign")}
        </Button>
      </div>
    </Dialog>
  );
}
