import type { NormalizedMoveResponse } from "@neurochess/contracts";

export type AiOutcome =
  | { readonly kind: "retry" }
  | { readonly kind: "move"; readonly move: string }
  | { readonly kind: "pause" }
  | { readonly kind: "technicalLoss" };

export function decideAiOutcome(
  classified: NormalizedMoveResponse,
  invalidOutputCount: number,
  retryCancelled: boolean,
): AiOutcome {
  // Legal-response cancellation is classified before its invocation is written.
  if (classified.ok) return { kind: "move", move: classified.output.move };
  if (classified.error.code !== "model_invalid") return { kind: "pause" };

  // The count includes this response; cancellation cannot erase an observed invalid output.
  if (invalidOutputCount >= 3) return { kind: "technicalLoss" };
  return retryCancelled ? { kind: "pause" } : { kind: "retry" };
}
