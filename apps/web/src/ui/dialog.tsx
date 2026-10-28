import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

import { Button } from "./button";
import { cx } from "./cx";
import { Icon } from "./icon";
import { cancelHeldActivation } from "./keyboard";

export interface DialogProps {
  readonly open?: boolean;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly onCancel: () => void;
  readonly closeLabel?: string;
  readonly children: ReactNode;
}

// Preflight removes native dialog margins; m-auto restores centering.
const dialogClassName = cx(
  "m-auto max-h-[calc(100dvh_-_32px)] w-[min(36rem,calc(100%_-_32px))] max-w-none overflow-auto rounded-panel border border-control-border bg-surface-raised p-6 text-text",
  "shadow-[0_1rem_4rem_var(--color-canvas)] backdrop:bg-canvas/85 max-sm:p-[min(1rem,16px)]",
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
 * Opening focuses the first control and contains Tab; closing restores trigger focus.
 * A closed dialog retains its form DOM. Escape requests cancellation from the owner.
 */
export function Dialog({
  open = true,
  title,
  description,
  onCancel,
  closeLabel,
  children,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    const trigger = document.activeElement;
    dialog.showModal();
    focusable(dialog)[0]?.focus();
    return () => {
      dialog.close();
      // Browsers restore focus on close; the jsdom polyfill does not. Never scroll the page for it.
      if (trigger instanceof HTMLElement && trigger.isConnected) {
        const hiddenPanel = trigger.closest('[role="tabpanel"][hidden]');
        const tabId = hiddenPanel?.getAttribute("aria-labelledby");
        const target = tabId ? document.getElementById(tabId) : trigger;
        target?.focus({ preventScroll: true });
      }
    };
  }, [open]);

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
      inert={!open}
      aria-hidden={open ? undefined : true}
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
            "flex flex-wrap-reverse items-start gap-3 bg-surface-raised sm:sticky sm:top-0 sm:z-10",
        )}
      >
        <h2
          id={titleId}
          className={cx(
            "text-section font-semibold",
            closeLabel && "flex min-h-target min-w-0 flex-1 basis-48 items-center",
          )}
        >
          {title}
        </h2>
        {closeLabel ? (
          <Button
            variant="dismiss"
            padding="compact"
            className="ml-auto size-target shrink-0"
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
