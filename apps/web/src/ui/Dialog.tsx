import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cx } from "./cx";

export interface DialogProps {
  readonly title: ReactNode;
  readonly description: ReactNode;
  /** Escape and the native cancel request. The owner then stops rendering the dialog. */
  readonly onCancel: () => void;
  readonly children: ReactNode;
}

// Centered on desktop, a scrollable sheet on narrow screens. Preflight zeroes every margin, so
// m-auto restores the native modal centering.
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
 * Modal dialog. It moves focus to its first control on open, contains Tab, reports Escape
 * through `onCancel`, and restores focus to the trigger when it unmounts. The owner decides
 * whether it is open by rendering it, so a stale dialog disappears with the state that opened it.
 */
export function Dialog({ title, description, onCancel, children }: DialogProps) {
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
    if ((event.key === "Enter" || event.key === " ") && event.repeat) {
      // A held activation key must not fire repeatedly.
      event.preventDefault();
    } else if (event.key === "Escape") {
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
      <h2 id={titleId} className="text-section font-semibold">
        {title}
      </h2>
      <p id={descriptionId} className="mt-3 text-text-secondary">
        {description}
      </p>
      {children}
    </dialog>,
    document.body,
  );
}
