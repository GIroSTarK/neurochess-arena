import { randomUUID } from "node:crypto";

import type {
  AiControlledTurnCommand,
  AiGameConfiguration,
  AiProvider,
  AiSeat,
  GameSnapshot,
  NormalizedMoveResponse,
} from "@neurochess/contracts";

import type { AiAdapters } from "../src/games/ai-turn.js";
import { createGameService } from "../src/games/service.js";
import type { MoveRequest } from "../src/providers/adapter.js";

import type { TestApi } from "./helpers.js";
import { createScriptedAdapter } from "./providers/scripted-adapter.js";
import { withTurnCatalog } from "./providers/turn-catalog.js";

export const whiteAi: AiSeat = {
  type: "ai",
  provider: "openai",
  modelId: "fixture-white",
  parameters: { temperature: 0 },
};
export const blackAi: AiSeat = {
  type: "ai",
  provider: "anthropic",
  modelId: "fixture-black",
  parameters: { maxOutputTokens: 100 },
};
export const aiMatch = {
  mode: "ai_vs_ai",
  seats: { white: whiteAi, black: blackAi },
} satisfies AiGameConfiguration;
export const humanMatch: AiGameConfiguration = {
  mode: "ai_vs_human",
  seats: { white: whiteAi, black: { type: "human" } },
};

export function service(api: TestApi, aiAdapters: AiAdapters = {}, repository = api.repository) {
  const games = createGameService(repository, {
    nodeEnv: "test",
    sandboxEnabled: true,
    aiAdapters: Object.fromEntries(
      Object.entries(aiAdapters).map(([provider, adapter]) => [provider, withTurnCatalog(adapter)]),
    ),
  });
  return {
    ...games,
    async createAi(...args: Parameters<typeof games.createAi>) {
      const details = await games.createAi(...args);
      await games.controller(args[0], {
        gameId: details.snapshot.gameId,
        controllerId: details.snapshot.gameId,
        expectedVersion: details.snapshot.version,
        action: "acquire",
      });
      return details;
    },
  };
}

export function turnCommand(snapshot: GameSnapshot): AiControlledTurnCommand {
  return {
    gameId: snapshot.gameId,
    expectedVersion: snapshot.version,
    commandId: randomUUID(),
    controllerId: snapshot.gameId,
  };
}

export function control(snapshot: GameSnapshot, action: "pause" | "resume" | "abort") {
  return {
    gameId: snapshot.gameId,
    expectedVersion: snapshot.version,
    commandId: randomUUID(),
    controllerId: snapshot.gameId,
    action,
  };
}

export function access(signal = new AbortController().signal) {
  return { apiKey: "request-only-sentinel-key", signal };
}

export function output(move: string, commentary?: string): NormalizedMoveResponse {
  return {
    ok: true,
    output: { move, ...(commentary === undefined ? {} : { commentary }) },
    usage: null,
    durationMs: 1,
    providerRequestId: null,
  };
}

export function gatedAdapter(
  provider: AiProvider = "openai",
  inspect?: (input: MoveRequest) => void,
) {
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<NormalizedMoveResponse>();
  const adapter = createScriptedAdapter({
    provider,
    moves: [
      async (input) => {
        inspect?.(input);
        entered.resolve();
        return response.promise;
      },
    ],
  });
  return { adapter, entered: entered.promise, resolve: response.resolve, reject: response.reject };
}
