import { failure, success } from "./result.js";
import {
  type CompletedOutcome,
  type DomainResult,
  DRAW_REASONS,
  type GameLifecycle,
  WIN_REASONS,
} from "./types.js";

export type LifecycleEvent =
  | { readonly type: "start" | "pause" | "resume" | "abort" }
  | { readonly type: "complete"; readonly outcome: CompletedOutcome };

export function transitionLifecycle(
  current: GameLifecycle,
  event: LifecycleEvent,
): DomainResult<GameLifecycle> {
  switch (event.type) {
    case "start":
      if (current.state === "configuring") {
        return success({ state: "active", result: "*", terminationReason: null });
      }
      break;
    case "pause":
      if (current.state === "active") {
        return success({ state: "paused", result: "*", terminationReason: null });
      }
      break;
    case "resume":
      if (current.state === "paused") {
        return success({ state: "active", result: "*", terminationReason: null });
      }
      break;
    case "abort":
      if (current.state === "active" || current.state === "paused") {
        return success({ state: "aborted", result: "*", terminationReason: "aborted" });
      }
      break;
    case "complete":
      if (current.state === "active" || current.state === "paused") {
        return success({ state: "completed", ...event.outcome });
      }
      break;
  }
  return failure("INVALID_GAME_STATE");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isGameLifecycle(value: unknown): value is GameLifecycle {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, "state") ||
    !Object.hasOwn(value, "result") ||
    !Object.hasOwn(value, "terminationReason")
  ) {
    return false;
  }

  const { state, result, terminationReason } = value;
  if (state === "configuring" || state === "active" || state === "paused") {
    return result === "*" && terminationReason === null;
  }
  if (state === "aborted") {
    return result === "*" && terminationReason === "aborted";
  }
  if (state !== "completed") {
    return false;
  }
  return result === "1/2-1/2"
    ? DRAW_REASONS.some((reason) => reason === terminationReason)
    : (result === "1-0" || result === "0-1") &&
        WIN_REASONS.some((reason) => reason === terminationReason);
}
