import type { NormalizedMoveResponse } from "@neurochess/contracts";

export type ClassifiedAiResponse =
  | { readonly kind: "legal"; readonly response: Extract<NormalizedMoveResponse, { ok: true }> }
  | { readonly kind: "invalid"; readonly response: Extract<NormalizedMoveResponse, { ok: false }> }
  | {
      readonly kind: "providerFailure";
      readonly response: Extract<NormalizedMoveResponse, { ok: false }>;
    };

export type AiOutcome =
  | { readonly kind: "retry" }
  | { readonly kind: "move"; readonly move: string }
  | { readonly kind: "pause" }
  | { readonly kind: "technicalLoss" };

export function decideAiOutcome(
  classified: ClassifiedAiResponse,
  invalidOutputCount: number,
  retryCancelled: boolean,
): AiOutcome {
  // Legal-response cancellation is classified before its invocation is written.
  if (classified.kind === "legal") return { kind: "move", move: classified.response.output.move };
  if (classified.kind === "providerFailure") return { kind: "pause" };

  // The count includes this response; cancellation cannot erase an observed invalid output.
  if (invalidOutputCount >= 3) return { kind: "technicalLoss" };
  return retryCancelled ? { kind: "pause" } : { kind: "retry" };
}
