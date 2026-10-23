import {
  type GameDetails,
  gameReplayResponseSchema,
  type GameSnapshot,
  gameSnapshotSchema,
} from "@neurochess/contracts";
import { vi } from "vitest";

import type { AiApi } from "../api/ai-client";
import { ApiFailure } from "../api/failures";

import { snapshot } from "./fixtures";

export function createMatchApiFixture(initial: GameDetails) {
  let stored = initial.snapshot;
  const api = {
    bootstrap: vi.fn<AiApi["bootstrap"]>(),
    discover: vi.fn<AiApi["discover"]>(),
    create: vi.fn<AiApi["create"]>(),
    details: vi.fn<AiApi["details"]>(async () => ({ ...initial, snapshot: stored })),
    snapshot: vi.fn<AiApi["snapshot"]>(async () => stored),
    controller: vi.fn<AiApi["controller"]>(async () => stored),
    unfinished: vi.fn<AiApi["unfinished"]>(async () => null),
    move: vi.fn<AiApi["move"]>(),
    invocations: vi.fn<AiApi["invocations"]>(async () => ({
      gameId: stored.gameId,
      version: stored.version,
      turns: [],
    })),
    turn: vi.fn<AiApi["turn"]>(),
    lifecycle: vi.fn<AiApi["lifecycle"]>(async (command) => {
      if (command.expectedVersion !== stored.version) {
        throw new ApiFailure("api", "GAME_CONFLICT", stored);
      }
      const state =
        command.action === "resume" ? "active" : command.action === "abort" ? "aborted" : "paused";
      stored = gameSnapshotSchema.parse({
        ...stored,
        version: stored.version + 1,
        state,
        legalMoves:
          state === "active" ? snapshot(stored.moves.map(({ uci }) => uci)).legalMoves : [],
        terminationReason: state === "aborted" ? "aborted" : null,
      });
      return stored;
    }),
    replay: vi.fn<AiApi["replay"]>(async () =>
      gameReplayResponseSchema.parse({ snapshot: stored, initialFen: snapshot().fen }),
    ),
    pgn: vi.fn<AiApi["pgn"]>(),
  } satisfies AiApi;

  return {
    api,
    readSnapshot: () => stored,
    seedSnapshot: (next: GameSnapshot) => {
      stored = next;
    },
  };
}
