import { createGame } from "@neurochess/chess";
import { type GameSnapshot, gameSnapshotSchema } from "@neurochess/contracts";

import { initialSandboxState, type SandboxState } from "../game/state";

export const GAME_ID = "30c898bd-d430-4c9e-bd9e-1f44bd7a8fab";
export const OTHER_GAME_ID = "b766c6d2-8129-4309-9d8f-fc9607849901";
export const FOOLS_MATE = ["f2f3", "e7e5", "g2g4", "d8h4"];
// Both promotions are reached through the public domain factory and legal
// moves from the standard position. No production FEN constructor is needed.
export const PROMOTION_APPROACH = ["a2a4", "h7h5", "a4a5", "h5h4", "a5a6", "h4h3", "a6b7", "h3g2"];
export const CASTLING_APPROACH = ["e2e4", "e7e5", "g1f3", "b8c6", "f1e2", "g8f6"];
export const EN_PASSANT_APPROACH = ["e2e4", "a7a6", "e4e5", "d7d5"];

export function snapshot(
  moves: readonly string[] = [],
  overrides: Partial<GameSnapshot> = {},
): GameSnapshot {
  const game = createGame();
  game.start();
  for (const move of moves) {
    if (!game.playMove(move).ok) throw new Error("Illegal test fixture move: " + move);
  }
  return gameSnapshotSchema.parse({
    ...game.snapshot(),
    gameId: GAME_ID,
    version: moves.length,
    ...overrides,
  });
}

/** A ready sandbox showing the standard position, for presentation tests. */
export function readyState(overrides: Partial<SandboxState> = {}): SandboxState {
  return {
    ...initialSandboxState,
    readiness: "ready",
    phase: "ready",
    snapshot: snapshot(),
    ...overrides,
  };
}

/** The path of a request the client made; it always hands fetch a URL instance. */
export function requestPath(input: RequestInfo | URL): string {
  return new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname;
}

/** The JSON body a request carried, or an empty string. */
export function requestBody(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : "";
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function errorResponse(
  code: string,
  status: number,
  currentSnapshot?: GameSnapshot,
): Response {
  return jsonResponse(
    {
      code,
      message: "server-message-canary-do-not-render",
      requestId: "test-request",
      ...(currentSnapshot ? { currentSnapshot } : {}),
    },
    status,
  );
}
