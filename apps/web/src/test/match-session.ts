import {
  type AiProvider,
  type ChessColor,
  type GameDetails,
  gameReplayResponseSchema,
  type GameSnapshot,
  gameSnapshotSchema,
  type ProviderCredentialSource,
} from "@neurochess/contracts";
import { vi } from "vitest";

import { type AiApi, AiRequestFailure } from "../api/ai-client";
import { ApiFailure } from "../api/failures";
import { createMatchComposition } from "../match/composition";
import type { SessionCredentials } from "../match/seat-credentials";
import type { MatchSession } from "../match/session";

import { snapshot } from "./fixtures";

const seat = { type: "ai", provider: "openai", modelId: "fixture", parameters: {} } as const;
export function matchDetails(human?: ChessColor): GameDetails {
  return {
    snapshot: snapshot(),
    configuration: human
      ? {
          mode: "ai_vs_human",
          seats:
            human === "white"
              ? { white: { type: "human" }, black: seat }
              : { white: seat, black: { type: "human" } },
        }
      : { mode: "ai_vs_ai", seats: { white: seat, black: seat } },
  };
}

// Replace only the browser-owned secret container; every gameplay collaborator stays real.
function memoryCredentials(signal: AbortSignal): SessionCredentials {
  const values = new Map<ChessColor, { provider: AiProvider; source: ProviderCredentialSource }>();
  const clear = () => values.clear();
  let disposed = false;
  const dispose = () => {
    disposed = true;
    clear();
    signal.removeEventListener("abort", dispose);
  };
  signal.addEventListener("abort", dispose, { once: true });
  function put(color: ChessColor, provider: AiProvider, source: ProviderCredentialSource) {
    if (disposed) throw new AiRequestFailure("AI_KEY_REQUIRED");
    values.set(color, { provider, source });
  }
  return {
    signal,
    clear,
    dispose,
    set: (color, provider, apiKey) => put(color, provider, { apiKey }),
    setSaved: (color, provider, credentialId) => put(color, provider, { credentialId }),
    remove: (color) => {
      values.delete(color);
    },
    require: (color, provider) => {
      const value = values.get(color);
      if (value?.provider !== provider) throw new AiRequestFailure("AI_KEY_REQUIRED");
      return { ...value.source };
    },
  };
}

const sessions: MatchSession[] = [];
export function cleanupMatches() {
  sessions.splice(0).forEach((session) => session.endLifetime());
}

export function matchHarness(initial = matchDetails()) {
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
        ...snapshot(stored.moves.map(({ uci }) => uci)),
        version: stored.version + 1,
        state,
        ...(state !== "active" ? { legalMoves: [] } : {}),
        terminationReason: state === "aborted" ? "aborted" : null,
      });
      return stored;
    }),
    replay: vi.fn<AiApi["replay"]>(async () =>
      gameReplayResponseSchema.parse({ snapshot: stored, initialFen: snapshot().fen }),
    ),
    pgn: vi.fn<AiApi["pgn"]>(),
  } satisfies AiApi;
  const delivery = { copy: vi.fn().mockResolvedValue(true), download: vi.fn() };
  const composition = createMatchComposition({
    api,
    delivery,
    createCredentials: memoryCredentials,
  });
  const { session, seats } = composition;
  sessions.push(session);
  void session.enter({ kind: "setup" });
  return {
    api,
    ...composition,
    seed: (next: GameSnapshot) => {
      stored = next;
    },
    enter: () =>
      session.enter({
        kind: "game",
        gameId: stored.gameId,
        details: { ...initial, snapshot: stored },
      }),
    keys: () => {
      seats.current?.set("white", "openai", "white-secret-sentinel");
      seats.current?.set("black", "openai", "black-secret-sentinel");
    },
  };
}
