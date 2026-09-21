import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

import { Button } from "./Button";
import { cx } from "./cx";
import { Icon } from "./Icon";
import { cancelHeldActivation } from "./keyboard";

export interface DialogProps {
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly onCancel: () => void;
  readonly closeLabel?: string;
  readonly children: ReactNode;
}

// Preflight removes native dialog margins; m-auto restores centering.
const dialogClassName = cx(
  "m-auto max-h-[calc(100dvh_-_32px)] w-[min(36rem,calc(100%_-_32px))] overflow-auto rounded-panel border border-control-border bg-surface-raised p-6 text-text",
  "shadow-[0_1rem_4rem_var(--color-canvas)] backdrop:bg-canvas/85 max-sm:p-4",
);

const focusableSelector = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function focusable(dialog: HTMLDialogElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(focusableSelector)];
}

/**
 * Mounting focuses the first control and contains Tab; unmounting restores trigger focus.
 * Escape requests cancellation through `onCancel`; the owner must unmount the dialog.
 */
export function Dialog({ title, description, onCancel, closeLabel, children }: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const trigger = document.activeElement;
    dialog.showModal();
    focusable(dialog)[0]?.focus();
    return () => {
      dialog.close();
      // Browsers restore focus on close; the jsdom polyfill does not. Never scroll the page for it.
      if (trigger instanceof HTMLElement && trigger.isConnected) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (cancelHeldActivation(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Tab") {
      const elements = focusable(event.currentTarget);
      const first = elements[0];
      const last = elements.at(-1);
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
      className={dialogClassName}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        className={cx(
          closeLabel &&
            "sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 bg-surface-raised",
        )}
      >
        <h2
          id={titleId}
          className={cx(
            "text-section font-semibold",
            closeLabel && "flex min-h-target items-center",
          )}
        >
          {title}
        </h2>
        {closeLabel ? (
          <Button
            variant="dismiss"
            padding="compact"
            className="size-target"
            aria-label={closeLabel}
            onClick={onCancel}
          >
            <Icon path="M6 6l12 12M18 6 6 18" />
          </Button>
        ) : null}
      </div>
      <p id={descriptionId} className="mt-3 text-text-secondary">
        {description}
      </p>
      {children}
    </dialog>,
    document.body,
  );
}
