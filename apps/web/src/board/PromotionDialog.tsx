import type { ChessColor } from "@neurochess/contracts";
import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { PieceIcon } from "./PieceIcon";
import type { PromotionKind, Square } from "./position";

interface PromotionDialogProps {
  readonly color: ChessColor;
  readonly destination: Square;
  readonly choices: readonly { kind: PromotionKind; move: string }[];
  readonly onChoose: (move: string) => void;
  readonly onCancel: () => void;
}

export function PromotionDialog({
  color,
  destination,
  choices,
  onChoose,
  onCancel,
}: PromotionDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>("button")?.focus();
    return () => dialog.close();
  }, []);

  function cancel() {
    dialogRef.current?.close();
    onCancel();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if ((event.key === "Enter" || event.key === " ") && event.repeat) {
      event.preventDefault();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    } else if (event.key === "Tab") {
      const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>("button");
      const first = buttons?.[0];
      const last = buttons?.[buttons.length - 1];
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
        cancel();
      }}
      onKeyDown={onKeyDown}
    >
      <h2 id={titleId}>
        {t("promotion.title", { color: t(`players.${color}`), square: destination })}
      </h2>
      <p id={descriptionId}>{t("promotion.description")}</p>
      <div className="promotion-choices">
        {choices.map(({ kind, move }) => (
          <button
            type="button"
            className="promotion-choice"
            key={kind}
            aria-label={t("promotion.choice", { piece: t(`promotion.${kind}`) })}
            onClick={() => {
              dialogRef.current?.close();
              onChoose(move);
            }}
          >
            <PieceIcon color={color} kind={kind} />
            <span>{t(`promotion.${kind}`)}</span>
          </button>
        ))}
      </div>
      <button type="button" className="button button--secondary" onClick={cancel}>
        {t("actions.cancel")}
      </button>
    </dialog>,
    document.body,
  );
}
