import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { LifecycleAction, SandboxController, SandboxState } from "./controller";

type Confirmation = { action: "abort" } | { action: "resign"; losingColor: "white" | "black" };

export function LifecycleControls({
  state,
  controller,
}: {
  readonly state: SandboxState;
  readonly controller: SandboxController;
}) {
  const { t } = useTranslation();
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const disabled = state.phase !== "ready";
  const paused = state.snapshot?.state === "paused";
  function submit(action: LifecycleAction) {
    void controller.lifecycle(action);
  }
  return (
    <div className="lifecycle-controls" aria-label={t("lifecycle.controls")} role="group">
      <button
        type="button"
        className="button button--primary"
        disabled={disabled}
        onClick={() => submit({ action: paused ? "resume" : "pause" })}
      >
        {t(paused ? "lifecycle.resume" : "lifecycle.pause")}
      </button>
      <button
        type="button"
        className="button button--secondary"
        disabled={disabled}
        onClick={() => setConfirmation({ action: "abort" })}
      >
        {t("lifecycle.abort")}
      </button>
      <button
        type="button"
        className="button button--secondary"
        disabled={disabled}
        onClick={() => setConfirmation({ action: "resign", losingColor: "white" })}
      >
        {t("lifecycle.resignWhite")}
      </button>
      <button
        type="button"
        className="button button--secondary"
        disabled={disabled}
        onClick={() => setConfirmation({ action: "resign", losingColor: "black" })}
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
