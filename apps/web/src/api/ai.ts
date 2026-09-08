import {
  type AiGameResponse,
  aiGameResponseSchema,
  aiRuntimeHeader,
  aiRuntimeIdSchema,
  type AiTurnCommand,
  aiTurnRequestSchema,
  type CreateAiGameRequest,
  createAiGameRequestSchema,
  gameParamsSchema,
  type GameSnapshot,
  type LifecycleCommand,
  lifecycleCommandSchema,
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
  acknowledgeRuntime?(runtimeId: string | null): void;
  leave?(command: LifecycleCommand): void;
  progress?(gameId: string, signal: AbortSignal): Promise<GameSnapshot>;
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
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  let runtimeId: string | null = null;
  function acknowledgeRuntime(value: string | null) {
    if (value === null) return;
    const parsed = aiRuntimeIdSchema.safeParse(value);
    if (!parsed.success) throw new ApiFailure("malformed");
    runtimeId = parsed.data;
  }
  const { gameRequest } = createGameTransport(apiBaseUrl, {
    timeoutMs: null,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      if (runtimeId) headers.set(aiRuntimeHeader, runtimeId);
      const response = await fetcher(input, runtimeId ? { ...init, headers } : init);
      if (init?.signal?.aborted) return response;
      const received = response.headers.get(aiRuntimeHeader);
      if (received !== null) {
        const parsed = aiRuntimeIdSchema.safeParse(received);
        if (!parsed.success) throw new ApiFailure("malformed");
        const changed = runtimeId !== null && runtimeId !== parsed.data;
        runtimeId = parsed.data;
        if (changed && response.status === 409) throw new ApiFailure("restart");
      }
      return response;
    },
  });
  const departure = createGameTransport(apiBaseUrl, { ...options, keepalive: true });
  const progress = createGameTransport(apiBaseUrl, {
    ...options,
    onResponse: (response) => {
      const received = response.headers.get(aiRuntimeHeader);
      if (received === null) return;
      const parsed = aiRuntimeIdSchema.safeParse(received);
      if (!parsed.success) throw new ApiFailure("malformed");
      // Observing progress must never acknowledge a restarted runtime for the pending turn.
      if (runtimeId !== null && runtimeId !== parsed.data) throw new ApiFailure("restart");
    },
  });
  return {
    acknowledgeRuntime,
    async progress(gameId, signal) {
      if (!gameParamsSchema.safeParse({ gameId }).success) throw new ApiFailure("malformed");
      return progress.gameRequest("/games/" + gameId, signal, gameId);
    },
    leave(command) {
      const body = lifecycleCommandSchema.safeParse(command);
      if (!body.success || command.action !== "pause") return;
      // Best effort on page exit; reopening must reconcile and fence again if this loses a race.
      void departure
        .gameRequest(
          "/games/" + command.gameId + "/lifecycle",
          new AbortController().signal,
          command.gameId,
          body.data,
        )
        .catch(() => undefined);
    },
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
  game(gameId: string, signal: AbortSignal): Promise<AiGameResponse>;
}

export function createAiSetupApi(
  apiBaseUrl: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): AiSetupApi {
  const { request, gameRequest, forGame } = createGameTransport(apiBaseUrl, {
    timeoutMs: 30_000,
    ...options,
  });
  return {
    async game(gameId, signal) {
      if (!gameParamsSchema.safeParse({ gameId }).success) throw new ApiFailure("malformed");
      const result = await request("/ai/games/" + gameId, aiGameResponseSchema, signal);
      return { ...result, snapshot: forGame(validateSnapshot(result.snapshot), gameId) };
    },
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
