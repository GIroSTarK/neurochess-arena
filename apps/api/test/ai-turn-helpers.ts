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
import { createGameService, type GameService } from "../src/games/service.js";
import type { Principal } from "../src/identity/principal.js";
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

export function createTestGameService(
  api: TestApi,
  aiAdapters: AiAdapters = {},
  repository = api.repository,
) {
  return createGameService(repository, {
    nodeEnv: "test",
    sandboxEnabled: true,
    aiAdapters: Object.fromEntries(
      Object.entries(aiAdapters).map(([provider, adapter]) => [provider, withTurnCatalog(adapter)]),
    ),
  });
}

export async function createControlledAiGame(
  games: GameService,
  principal: Principal,
  configuration: AiGameConfiguration,
  controllerId: string,
) {
  const details = await games.createAi(principal, configuration);
  await games.controller(principal, {
    gameId: details.snapshot.gameId,
    controllerId,
    expectedVersion: details.snapshot.version,
    action: "acquire",
  });
  return { details, controllerId };
}

export function turnCommand(snapshot: GameSnapshot, controllerId: string): AiControlledTurnCommand {
  return {
    gameId: snapshot.gameId,
    expectedVersion: snapshot.version,
    commandId: randomUUID(),
    controllerId,
  };
}

export function control(
  snapshot: GameSnapshot,
  action: "pause" | "resume" | "abort",
  controllerId: string,
) {
  return {
    gameId: snapshot.gameId,
    expectedVersion: snapshot.version,
    commandId: randomUUID(),
    controllerId,
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
