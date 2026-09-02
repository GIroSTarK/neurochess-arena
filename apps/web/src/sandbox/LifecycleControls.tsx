import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

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
      className="lifecycle-controls"
      aria-label={t("lifecycle.controls")}
      role="group"
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && event.repeat) event.preventDefault();
      }}
    >
      {/* aria-disabled blocks activation through the guards without blurring focus. */}
      <button
        type="button"
        className="button button--primary"
        aria-disabled={disabled}
        onClick={() => submit({ action: paused ? "resume" : "pause" })}
      >
        <StableText
          value={t(paused ? "lifecycle.resume" : "lifecycle.pause")}
          variants={[t("lifecycle.pause"), t("lifecycle.resume")]}
        />
      </button>
      <button
        type="button"
        className="button button--secondary"
        aria-disabled={disabled}
        onClick={() => confirm({ action: "abort" })}
      >
        {t("lifecycle.abort")}
      </button>
      <button
        type="button"
        className="button button--secondary"
        aria-disabled={disabled}
        onClick={() => confirm({ action: "resign", losingColor: "white" })}
      >
        {t("lifecycle.resignWhite")}
      </button>
      <button
        type="button"
        className="button button--secondary"
        aria-disabled={disabled}
        onClick={() => confirm({ action: "resign", losingColor: "black" })}
      >
        {t("lifecycle.resignBlack")}
      </button>
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
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  function keyboard(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if ((event.key === "Enter" || event.key === " ") && event.repeat) event.preventDefault();
    else if (event.key === "Tab") {
      const buttons = dialogRef.current?.querySelectorAll("button");
      const first = buttons?.[0];
      const last = buttons?.[1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }
  return createPortal(
    <dialog
      ref={dialogRef}
      className="promotion-dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onKeyDown={keyboard}
    >
      <h2 id={titleId}>
        {action.action === "abort"
          ? t("lifecycle.abortTitle")
          : t("lifecycle.resignTitle", { color: t(`players.${action.losingColor}`) })}
      </h2>
      <p id={descriptionId}>
        {action.action === "abort"
          ? t("lifecycle.abortDescription")
          : t("lifecycle.resignDescription", {
              winner: t(action.losingColor === "white" ? "players.black" : "players.white"),
            })}
      </p>
      <div className="dialog-actions">
        <button type="button" className="button button--secondary" onClick={onCancel}>
          {t("actions.cancel")}
        </button>
        <button type="button" className="button button--danger" onClick={onConfirm}>
          {t(action.action === "abort" ? "lifecycle.confirmAbort" : "lifecycle.confirmResign")}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
