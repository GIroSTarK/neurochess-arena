import {
  type AiTurnCommand,
  aiTurnRequestSchema,
  type CreateAiGameRequest,
  createAiGameRequestSchema,
  type GameSnapshot,
  modelDiscoveryRequestSchema,
  type ModelDiscoveryResponse,
  modelDiscoveryResponseSchema,
  type ProviderDescriptor,
  providerListResponseSchema,
  type SessionCredential,
  unfinishedGameResponseSchema,
} from "@neurochess/contracts";

import { ApiFailure, createGameTransport, validateSnapshot } from "./client";

export interface AiTurnApi {
  turn(
    command: AiTurnCommand,
    credential: SessionCredential,
    signal: AbortSignal,
  ): Promise<GameSnapshot>;
}

export function createAiTurnApi(
  apiBaseUrl: string,
  options: { fetch?: typeof fetch } = {},
): AiTurnApi {
  // One turn can include model discovery and three provider attempts. Provider transport
  // deadlines belong to the API; the ordinary ten-second client deadline cannot bound a turn.
  const { gameRequest } = createGameTransport(apiBaseUrl, { ...options, timeoutMs: null });
  return {
    async turn(command, credential, signal) {
      const body = aiTurnRequestSchema.safeParse({ ...command, credential });
      if (!body.success) throw new ApiFailure("malformed");
      try {
        return await gameRequest(
          "/games/" + command.gameId + "/ai-turn",
          signal,
          command.gameId,
          body.data,
        );
      } finally {
        body.data.credential.apiKey = "";
      }
    },
  };
}

export interface AiSetupApi {
  providers(signal: AbortSignal): Promise<ProviderDescriptor[]>;
  discover(
    credential: SessionCredential,
    signal: AbortSignal,
    catalogId?: string,
  ): Promise<ModelDiscoveryResponse>;
  create(configuration: CreateAiGameRequest, signal: AbortSignal): Promise<GameSnapshot>;
  unfinished(signal: AbortSignal): Promise<GameSnapshot | null>;
}

export function createAiSetupApi(
  apiBaseUrl: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): AiSetupApi {
  const { request, gameRequest } = createGameTransport(apiBaseUrl, {
    timeoutMs: 30_000,
    ...options,
  });
  return {
    async providers(signal) {
      const { providers } = await request("/ai/providers", providerListResponseSchema, signal);
      if (new Set(providers.map(({ id }) => id)).size !== providers.length) {
        throw new ApiFailure("malformed");
      }
      return providers;
    },
    async discover(credential, signal, catalogId) {
      const body = modelDiscoveryRequestSchema.safeParse({
        credential,
        ...(catalogId === undefined ? {} : { catalogId }),
      });
      if (!body.success) throw new ApiFailure("malformed");
      try {
        const result = await request("/ai/models", modelDiscoveryResponseSchema, signal, body.data);
        if (
          result.ok &&
          (result.value.some((model) => model.provider !== credential.provider) ||
            JSON.stringify(result.value).includes(credential.apiKey))
        ) {
          throw new ApiFailure("malformed");
        }
        return result;
      } finally {
        body.data.credential.apiKey = "";
      }
    },
    async create(configuration, signal) {
      const body = createAiGameRequestSchema.safeParse(configuration);
      if (!body.success) throw new ApiFailure("malformed");
      return gameRequest("/ai/games", signal, undefined, body.data);
    },
    async unfinished(signal) {
      const result = await request("/ai/games/unfinished", unfinishedGameResponseSchema, signal);
      return result.snapshot ? validateSnapshot(result.snapshot) : null;
    },
  };
}
