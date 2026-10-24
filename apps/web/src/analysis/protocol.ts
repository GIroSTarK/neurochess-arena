import { type ReplayedPosition, replayPositions } from "@neurochess/chess";
import { z } from "zod";

export const PROFILE_ID = "sf19-lite-single-v2";
export const ENGINE_DIRECTORY = `engines/${PROFILE_ID}`;
export const UNAVAILABLE_REASONS = [
  "unsupported_browser",
  "engine_load_failed",
  "initialization_timeout",
  "engine_protocol_error",
  "search_timeout",
  "engine_crashed",
  "resource_limit",
  "no_score",
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];
export type AnalysisScore =
  | { readonly kind: "cp"; readonly value: number }
  | { readonly kind: "mate"; readonly winner: "white" | "black"; readonly moves: number };

const uci = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
const requestSchema = z.strictObject({
  lifetime: z.string().min(1).max(128),
  gameId: z.uuid(),
  generation: z.int().positive(),
  ply: z.int().nonnegative(),
  fen: z.string().min(1).max(128),
  moves: z.array(uci),
  historyDigest: z.string().regex(/^[0-9a-f]{64}$/),
  profileId: z.literal(PROFILE_ID),
});
export type AnalysisRequest = z.infer<typeof requestSchema>;
export type AnalysisTarget = Omit<AnalysisRequest, "generation">;
export type SampleIdentity = Omit<AnalysisRequest, "moves">;
export type AnalysisSample = SampleIdentity & {
  readonly depth: number;
  readonly durationMs: number;
  readonly score: AnalysisScore;
};
export interface PositionFacts {
  readonly turn: "white" | "black";
  readonly checkmate: boolean;
  readonly noLegalMoves: boolean;
}

export async function historyDigest(moves: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(["standard-v1", ...moves]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function validateRequest(
  input: unknown,
  signal?: AbortSignal,
): Promise<{ request: AnalysisRequest; position: PositionFacts }> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new Error("engine_protocol_error");
  const request = parsed.data;
  if (
    request.moves.length !== request.ply ||
    (await historyDigest(request.moves)) !== request.historyDigest
  ) {
    throw new Error("engine_protocol_error");
  }
  return { request, position: await positionFacts(request.moves, request.fen, signal) };
}

export async function visitPositions(
  moves: readonly string[],
  visit: (position: ReplayedPosition) => void,
  signal?: AbortSignal,
): Promise<void> {
  let sliceStart = performance.now();
  for (const result of replayPositions(moves)) {
    if (signal?.aborted) throw new Error("analysis_cancelled");
    if (!result.ok) throw new Error("engine_protocol_error");
    visit(result.value);
    if (
      result.value.ply < moves.length &&
      (performance.now() - sliceStart >= 8 || result.value.ply % 8 === 7)
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }
}

export async function positionFacts(
  moves: readonly string[],
  fen: string,
  signal?: AbortSignal,
): Promise<PositionFacts> {
  let snapshot: ReplayedPosition | undefined;
  await visitPositions(
    moves,
    (position) => {
      snapshot = position;
    },
    signal,
  );
  if (fen !== snapshot?.fen) throw new Error("engine_protocol_error");
  return {
    turn: snapshot.turn,
    checkmate: snapshot.terminationReason === "checkmate",
    noLegalMoves:
      snapshot.terminationReason === "checkmate" || snapshot.terminationReason === "stalemate",
  };
}

export function sampleIdentity(request: AnalysisRequest): SampleIdentity {
  return {
    lifetime: request.lifetime,
    gameId: request.gameId,
    generation: request.generation,
    ply: request.ply,
    fen: request.fen,
    historyDigest: request.historyDigest,
    profileId: request.profileId,
  };
}
