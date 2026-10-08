import type { ReactNode } from "react";

import { Button } from "./Button";
import { Dialog, type DialogProps } from "./Dialog";

export interface ConfirmDialogProps extends Omit<DialogProps, "children" | "closeLabel"> {
  readonly children?: ReactNode;
  readonly cancelLabel: string;
  readonly confirmLabel: string;
  readonly onConfirm?: () => void;
  readonly cancelDisabled?: boolean;
  readonly confirmDisabled?: boolean;
  readonly confirmForm?: string;
  readonly actionsClassName?: string;
  readonly buttonClassName?: string;
}

export function ConfirmDialog({
  children,
  cancelLabel,
  confirmLabel,
  onCancel,
  onConfirm,
  cancelDisabled,
  confirmDisabled,
  confirmForm,
  actionsClassName = "mt-6 flex flex-wrap gap-3",
  buttonClassName,
  ...dialog
}: ConfirmDialogProps) {
  return (
    <Dialog {...dialog} onCancel={onCancel}>
      {children}
      <div className={actionsClassName}>
        <Button
          variant="secondary"
          className={buttonClassName}
          aria-disabled={cancelDisabled}
          onClick={onCancel}
        >
          {cancelLabel}
        </Button>
        <Button
          variant="danger"
          className={buttonClassName}
          type={confirmForm ? "submit" : "button"}
          form={confirmForm}
          aria-disabled={confirmDisabled}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
