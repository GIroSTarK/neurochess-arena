import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

import type { LifecycleAction, SandboxController, SandboxState } from "./controller";
import { StableText } from "./StableText";

type Confirmation = { action: "abort" } | { action: "resign"; losingColor: "white" | "black" };

interface PendingConfirmation {
  readonly epoch: string;
  readonly action: Confirmation;
}

export function LifecycleControls({
  state,
  controller,
}: {
  readonly state: SandboxState;
  readonly controller: SandboxController;
}) {
  const { t } = useTranslation();
  const [pendingConfirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const disabled = state.phase !== "ready";
  const paused = state.snapshot?.state === "paused";
  const epoch =
    state.snapshot?.gameId + ":" + state.snapshot?.version + ":" + state.interactionRevision;
  // Invalidate the dialog without replacing the controls or moving their focus.
  const confirmation =
    !disabled && pendingConfirmation?.epoch === epoch ? pendingConfirmation.action : null;
  function submit(action: LifecycleAction) {
    if (disabled) return;
    void controller.lifecycle(action);
  }
  function confirm(action: Confirmation) {
    if (!disabled) setConfirmation({ epoch, action });
  }
  return (
    <div
      className="mt-4 grid grid-cols-2 gap-3"
      aria-label={t("lifecycle.controls")}
      role="group"
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && event.repeat) event.preventDefault();
      }}
    >
      {/* aria-disabled blocks activation through the guards without blurring focus. */}
      <Button
        variant="primary"
        aria-disabled={disabled}
        onClick={() => submit({ action: paused ? "resume" : "pause" })}
      >
        <StableText
          value={t(paused ? "lifecycle.resume" : "lifecycle.pause")}
          variants={[t("lifecycle.pause"), t("lifecycle.resume")]}
          align="center"
        />
      </Button>
      <Button
        variant="secondary"
        aria-disabled={disabled}
        onClick={() => confirm({ action: "abort" })}
      >
        {t("lifecycle.abort")}
      </Button>
      <Button
        variant="secondary"
        aria-disabled={disabled}
        onClick={() => confirm({ action: "resign", losingColor: "white" })}
      >
        {t("lifecycle.resignWhite")}
      </Button>
      <Button
        variant="secondary"
        aria-disabled={disabled}
        onClick={() => confirm({ action: "resign", losingColor: "black" })}
      >
        {t("lifecycle.resignBlack")}
      </Button>
      {confirmation ? (
        <ConfirmationDialog
          action={confirmation}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            setConfirmation(null);
            submit(confirmation);
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
