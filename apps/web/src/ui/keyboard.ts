import type { KeyboardEvent } from "react";

/**
 * Cancels the repeated keydown of a held Enter or Space so that an activation fires once per
 * press. Returns true when the event was such a repeat.
 */
export function cancelHeldActivation(event: KeyboardEvent): boolean {
  if ((event.key === "Enter" || event.key === " ") && event.repeat) {
    event.preventDefault();
    return true;
  }
  return false;
}
