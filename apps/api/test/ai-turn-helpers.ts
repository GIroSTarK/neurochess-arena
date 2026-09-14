import { randomUUID } from "node:crypto";

import type {
  AiGameConfiguration,
  AiProvider,
  AiSeat,
  AiTurnCommand,
  GameSnapshot,
  NormalizedMoveResponse,
} from "@neurochess/contracts";

import type { AiAdapters } from "../src/games/ai-turn.js";
import { createGameService } from "../src/games/service.js";
import type { MoveRequest } from "../src/providers/adapter.js";

import type { TestApi } from "./helpers.js";
import { createScriptedAdapter } from "./providers/scripted-adapter.js";

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
  return createGameService(repository, { nodeEnv: "test", sandboxEnabled: true, aiAdapters });
}

export function turnCommand(snapshot: GameSnapshot): AiTurnCommand {
  return { gameId: snapshot.gameId, expectedVersion: snapshot.version, commandId: randomUUID() };
}

export function control(snapshot: GameSnapshot, action: "pause" | "resume" | "abort") {
  return { ...turnCommand(snapshot), action };
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
