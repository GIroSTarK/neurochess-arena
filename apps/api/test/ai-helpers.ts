import { randomUUID } from "node:crypto";

import {
  type AiConfiguration,
  type AiTurnCommand,
  type CreateAiGameRequest,
  type GameSnapshot,
  gameSnapshotSchema,
  type ModelDescriptor,
} from "@neurochess/contracts";
import { expect } from "vitest";

import type { AiGameOptions } from "../src/games/ai-service.js";
import type { AiProviderAdapter, MoveRequest } from "../src/providers/adapter.js";
import { createScriptedMockProvider, type MockMoveStep } from "../src/providers/mock.js";

import { type TestApi, type TestGuest, WEB_ORIGIN } from "./helpers.js";

export const model: ModelDescriptor = {
  provider: "openai",
  id: "fixture-model",
  name: "Fixture model",
  supportedParameters: {
    temperature: { min: 0, max: 2 },
    maxOutputTokens: { min: 16, max: 4096 },
  },
};
export const white: AiConfiguration = {
  provider: model.provider,
  modelId: model.id,
  parameters: { temperature: 0 },
};
export const black: AiConfiguration = {
  ...white,
  parameters: { temperature: 1.5, maxOutputTokens: 100 },
};
export const creation = { mode: "ai_vs_ai", white, black } satisfies CreateAiGameRequest;

export function mock(steps: readonly MockMoveStep[]) {
  return createScriptedMockProvider({
    descriptor: { id: "openai", name: "Fixture provider" },
    models: [model],
    moves: steps,
  });
}

export function runtime(adapter: AiProviderAdapter, leaseMs?: number): AiGameOptions {
  return {
    providers: [{ adapter, models: [model] }],
    ...(leaseMs === undefined ? {} : { leaseMs }),
  };
}

export function controlled(steps: readonly MockMoveStep[], gateAttempt = 1) {
  const provider = mock(steps);
  const entered = Promise.withResolvers<MoveRequest>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const adapter: AiProviderAdapter = {
    ...provider,
    async requestMove(input) {
      const result = await provider.requestMove(input);
      if (++calls === gateAttempt) {
        entered.resolve(input);
        await release.promise;
      }
      return result;
    },
  };
  return { provider, adapter, entered: entered.promise, release: () => release.resolve() };
}

export function post(api: TestApi, guest: TestGuest, url: string, payload: unknown) {
  return api.app.inject({
    method: "POST",
    url,
    payload: payload as object,
    headers: { origin: WEB_ORIGIN, cookie: guest.cookie },
  });
}

export async function createAi(
  api: TestApi,
  guest: TestGuest,
  request: CreateAiGameRequest = creation,
) {
  const response = await post(api, guest, "/ai/games", request);
  expect(response.statusCode, response.body).toBe(201);
  return gameSnapshotSchema.parse(response.json());
}

export function aiCommand(current: GameSnapshot): AiTurnCommand {
  return { gameId: current.gameId, expectedVersion: current.version, commandId: randomUUID() };
}

export function turn(api: TestApi, guest: TestGuest, request: AiTurnCommand) {
  return post(api, guest, `/games/${request.gameId}/ai-turn`, request);
}

export function lifecycle(
  api: TestApi,
  guest: TestGuest,
  current: GameSnapshot,
  action: "pause" | "resume" | "abort" | "resign",
  losingColor?: "white" | "black",
) {
  return post(api, guest, `/games/${current.gameId}/lifecycle`, {
    ...aiCommand(current),
    action,
    ...(losingColor ? { losingColor } : {}),
  });
}

export function discover(api: TestApi, guest: TestGuest) {
  return api.app.inject({
    method: "GET",
    url: "/ai/games/unfinished",
    headers: { cookie: guest.cookie },
  });
}

export async function records(api: TestApi, gameId: string) {
  return api.repository.read(async (reader) => ({
    game: await reader.getGame(gameId),
    participants: await reader.getParticipants(gameId),
    moves: await reader.getMoves(gameId),
    invocations: await reader.getModelInvocations(gameId),
    reservations: await reader.getTurnReservations(gameId),
  }));
}
