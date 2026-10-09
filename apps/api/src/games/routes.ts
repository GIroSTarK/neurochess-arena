import {
  aiControllerRequestSchema,
  aiErrorResponseSchema,
  aiGameConfigurationSchema,
  aiTurnRequestSchema,
  createGameRequestSchema,
  emptyQuerySchema,
  expectedAccountSchema,
  gameDeleteRequestSchema,
  gameDetailsSchema,
  gameHistoryClearRequestSchema,
  gameHistoryDeletedResponseSchema,
  gameHistoryQuerySchema,
  gameHistoryResponseSchema,
  gameInvocationsSchema,
  gameParamsSchema,
  gamePgnResponseSchema,
  gameReplayResponseSchema,
  gameSnapshotSchema,
  guestSessionRequestSchema,
  guestSessionResponseSchema,
  lifecycleCommandSchema,
  modelDiscoveryRequestSchema,
  modelDiscoveryResultSchema,
  moveCommandSchema,
  unfinishedGameDetailsSchema,
  unfinishedGameResponseSchema,
} from "@neurochess/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { AccountAuth } from "../auth/service.js";
import { authenticateGuestRequest, setGuestCookie } from "../guests/http.js";
import { GUEST_COOKIE_NAME, type GuestService } from "../guests/service.js";
import { publicPrincipalFor } from "../identity/http.js";
import type { Principal } from "../identity/principal.js";
import {
  AI_TURN_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  providerRequestScope,
} from "../providers/request-scope.js";

import { GameRequestError } from "./errors.js";
import { gameErrorResponses, handleGameError } from "./http.js";
import type { GameService } from "./service.js";

export interface GameApiOptions {
  readonly auth?: AccountAuth;
  readonly games: GameService;
  readonly guests: GuestService;
  readonly webOrigin: string;
  readonly providerTimeouts?: { readonly discoveryMs?: number; readonly turnMs?: number };
}

export async function registerGameRoutes(
  app: FastifyInstance,
  options: GameApiOptions,
): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  let sweeping: Promise<void> | undefined;
  const sweep = () => {
    sweeping ??= options.games
      .expireControllers()
      .catch((error: unknown) => {
        app.log.error({ err: error }, "Controller presence cleanup failed");
      })
      .finally(() => {
        sweeping = undefined;
      });
  };
  const presenceTimer = setInterval(sweep, 2_000);
  presenceTimer.unref();
  let roomCleanup: Promise<void> | undefined;
  const sweepRooms = () => {
    roomCleanup ??= options.games
      .cleanupSharedRooms()
      .catch(() => {
        app.log.error("Shared room cleanup failed");
      })
      .finally(() => {
        roomCleanup = undefined;
      });
  };
  const roomTimer = setInterval(sweepRooms, 30_000);
  roomTimer.unref();
  app.addHook("onReady", async () => {
    sweep();
    sweepRooms();
    await Promise.all([sweeping, roomCleanup]);
  });
  app.addHook("onClose", async () => {
    clearInterval(presenceTimer);
    clearInterval(roomTimer);
    await Promise.all([sweeping, roomCleanup]);
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.method === "POST" && request.headers.origin !== options.webOrigin) {
      throw new GameRequestError("FORBIDDEN");
    }
  });
  app.setErrorHandler(handleGameError);

  async function principalFor(
    request: FastifyRequest,
    reply: FastifyReply,
    accountOnly = false,
  ): Promise<Principal> {
    const params = gameParamsSchema.safeParse(request.params);
    // The immutable server-owned marker selects Sandbox authority on shared routes.
    // It never permits guest fallback for an ordinary public game.
    if (!accountOnly && params.success && (await options.games.isSandboxGame(params.data.gameId))) {
      return authenticateGuestRequest(options.guests, request, reply);
    }
    return publicPrincipalFor(options, request, reply, accountOnly);
  }

  const aiErrors = {
    ...gameErrorResponses,
    409: aiErrorResponseSchema,
    422: aiErrorResponseSchema,
  };

  routes.post(
    "/games/:gameId/delete",
    {
      bodyLimit: 1024,
      schema: {
        params: gameParamsSchema,
        body: gameDeleteRequestSchema,
        querystring: emptyQuerySchema,
        response: { 200: gameHistoryDeletedResponseSchema, ...gameErrorResponses },
      },
    },
    async (request, reply) => {
      if (request.params.gameId.toLowerCase() !== request.body.gameId.toLowerCase()) {
        throw new GameRequestError("INVALID_REQUEST");
      }
      return options.games.deleteGame(await principalFor(request, reply, true), request.body, () =>
        request.log.error("Shared room cleanup failed"),
      );
    },
  );

  routes.post(
    "/games/history/clear",
    {
      bodyLimit: 1024,
      schema: {
        body: gameHistoryClearRequestSchema,
        querystring: emptyQuerySchema,
        response: { 200: gameHistoryDeletedResponseSchema, ...gameErrorResponses },
      },
    },
    async (request, reply) =>
      options.games.clearHistory(await principalFor(request, reply, true), request.body, () =>
        request.log.error("Shared room cleanup failed"),
      ),
  );

  routes.get(
    "/games/history",
    {
      schema: {
        querystring: gameHistoryQuerySchema,
        response: { 200: gameHistoryResponseSchema, ...gameErrorResponses },
      },
    },
    async (request, reply) =>
      options.games.history(await principalFor(request, reply, true), request.query),
  );

  routes.post(
    "/games/:gameId/controller",
    {
      schema: {
        params: gameParamsSchema,
        body: aiControllerRequestSchema,
        querystring: emptyQuerySchema,
        response: { 200: gameSnapshotSchema, ...aiErrors },
      },
    },
    async (request, reply) => {
      if (request.params.gameId.toLowerCase() !== request.body.gameId.toLowerCase()) {
        throw new GameRequestError("INVALID_REQUEST");
      }
      return options.games.controller(await principalFor(request, reply), request.body);
    },
  );

  routes.post(
    "/providers/models",
    {
      schema: {
        body: modelDiscoveryRequestSchema,
        querystring: emptyQuerySchema,
        response: { 200: modelDiscoveryResultSchema, ...aiErrors },
      },
    },
    async (request, reply) => {
      const principal = await principalFor(request, reply);
      const scope = providerRequestScope(
        request,
        reply,
        options.providerTimeouts?.discoveryMs ?? DISCOVERY_TIMEOUT_MS,
      );
      try {
        return await options.games.models(principal, request.body.provider, {
          ...("apiKey" in request.body
            ? { apiKey: request.body.apiKey }
            : { credentialId: request.body.credentialId }),
          signal: scope.signal,
        });
      } finally {
        if ("apiKey" in request.body) request.body.apiKey = "";
        scope.dispose();
      }
    },
  );

  routes.post(
    "/games",
    {
      schema: {
        body: aiGameConfigurationSchema,
        querystring: emptyQuerySchema,
        response: { 201: gameDetailsSchema, ...gameErrorResponses },
      },
    },
    async (request, reply) => {
      const game = await options.games.createAi(await principalFor(request, reply), request.body);
      return reply.code(201).send(game);
    },
  );

  routes.get(
    "/games/unfinished",
    {
      schema: {
        querystring: emptyQuerySchema,
        response: { 200: unfinishedGameDetailsSchema, ...gameErrorResponses },
      },
    },
    async (request, reply) => options.games.unfinishedGame(await principalFor(request, reply)),
  );

  routes.get(
    "/games/:gameId/details",
    {
      schema: {
        params: gameParamsSchema,
        querystring: emptyQuerySchema,
        response: { 200: gameDetailsSchema, ...gameErrorResponses },
      },
    },
    async (request, reply) =>
      options.games.details(await principalFor(request, reply), request.params.gameId),
  );

  routes.get(
    "/games/:gameId/invocations",
    {
      schema: {
        params: gameParamsSchema,
        querystring: emptyQuerySchema,
        response: { 200: gameInvocationsSchema, ...gameErrorResponses },
      },
    },
    async (request, reply) =>
      options.games.invocations(await principalFor(request, reply), request.params.gameId),
  );

  routes.post(
    "/games/:gameId/ai-turn",
    {
      schema: {
        params: gameParamsSchema,
        body: aiTurnRequestSchema,
        querystring: emptyQuerySchema,
        response: { 200: gameSnapshotSchema, ...aiErrors },
      },
    },
    async (request, reply) => {
      if (request.params.gameId.toLowerCase() !== request.body.gameId.toLowerCase()) {
        throw new GameRequestError("INVALID_REQUEST");
      }
      const principal = await principalFor(request, reply);
      const scope = providerRequestScope(
        request,
        reply,
        options.providerTimeouts?.turnMs ?? AI_TURN_TIMEOUT_MS,
      );
      try {
        const { gameId, expectedVersion, commandId, controllerId, step } = request.body;
        return await options.games.aiTurn(
          principal,
          {
            gameId,
            expectedVersion,
            commandId,
            controllerId,
            ...(step === undefined ? {} : { step }),
          },
          {
            ...("apiKey" in request.body
              ? { apiKey: request.body.apiKey }
              : { credentialId: request.body.credentialId }),
            signal: scope.signal,
          },
        );
      } finally {
        if ("apiKey" in request.body) request.body.apiKey = "";
        scope.dispose();
      }
    },
  );

  routes.post(
    "/guest-session",
    {
      schema: {
        body: guestSessionRequestSchema,
        querystring: emptyQuerySchema,
        response: { 200: guestSessionResponseSchema, ...gameErrorResponses },
      },
    },
    async (request, reply) => {
      const expected = expectedAccountSchema.safeParse(
        request.headers["x-neurochess-expected-account"],
      );
      if (!expected.success) throw new GameRequestError("INVALID_REQUEST");
      if (
        expected.data !== undefined &&
        (expected.data !== "guest" ||
          (await options.auth?.resolve(
            new Headers(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
          )))
      ) {
        throw new GameRequestError("UNAUTHORIZED");
      }
      const identity = await options.guests.bootstrap(request.cookies[GUEST_COOKIE_NAME]);
      setGuestCookie(reply, identity, options.guests.ttlSeconds);
      return { status: "ready" as const };
    },
  );

  routes.post(
    "/sandbox/games",
    {
      onRequest: async () => {
        if (!options.games.sandboxEnabled) throw new GameRequestError("NOT_FOUND");
      },
      schema: {
        body: createGameRequestSchema,
        querystring: emptyQuerySchema,
        response: { 201: gameSnapshotSchema, ...gameErrorResponses },
      },
    },
    async (request, reply) => {
      const principal = await authenticateGuestRequest(options.guests, request, reply);
      const snapshot = await options.games.createSandbox(principal);
      return reply.code(201).send(snapshot);
    },
  );

  routes.get(
    "/sandbox/games/unfinished",
    {
      onRequest: async () => {
        if (!options.games.sandboxEnabled) throw new GameRequestError("NOT_FOUND");
      },
      schema: {
        querystring: emptyQuerySchema,
        response: { 200: unfinishedGameResponseSchema, ...gameErrorResponses },
      },
    },
    async (request, reply) =>
      options.games.unfinished(await authenticateGuestRequest(options.guests, request, reply)),
  );

  routes.post(
    "/games/:gameId/lifecycle",
    {
      schema: {
        params: gameParamsSchema,
        body: lifecycleCommandSchema,
        querystring: emptyQuerySchema,
        response: { 200: gameSnapshotSchema, ...aiErrors },
      },
    },
    async (request, reply) => {
      if (request.params.gameId.toLowerCase() !== request.body.gameId.toLowerCase()) {
        throw new GameRequestError("INVALID_REQUEST");
      }
      return options.games.lifecycle(await principalFor(request, reply), request.body);
    },
  );

  routes.get(
    "/games/:gameId/replay",
    {
      schema: {
        params: gameParamsSchema,
        querystring: emptyQuerySchema,
        response: { 200: gameReplayResponseSchema, ...gameErrorResponses },
      },
    },
    async (request, reply) =>
      options.games.replay(await principalFor(request, reply), request.params.gameId),
  );

  routes.get(
    "/games/:gameId/pgn",
    {
      schema: {
        params: gameParamsSchema,
        querystring: emptyQuerySchema,
        response: { 200: gamePgnResponseSchema, ...gameErrorResponses },
      },
    },
    async (request, reply) =>
      options.games.pgn(await principalFor(request, reply), request.params.gameId),
  );

  routes.get(
    "/games/:gameId",
    {
      schema: {
        params: gameParamsSchema,
        querystring: emptyQuerySchema,
        response: { 200: gameSnapshotSchema, ...gameErrorResponses },
      },
    },
    async (request, reply) => {
      const principal = await principalFor(request, reply);
      return options.games.snapshot(principal, request.params.gameId);
    },
  );

  routes.post(
    "/games/:gameId/moves",
    {
      schema: {
        params: gameParamsSchema,
        body: moveCommandSchema,
        querystring: emptyQuerySchema,
        response: { 200: gameSnapshotSchema, ...gameErrorResponses },
      },
    },
    async (request, reply) => {
      if (request.params.gameId.toLowerCase() !== request.body.gameId.toLowerCase()) {
        throw new GameRequestError("INVALID_REQUEST");
      }
      const principal = await principalFor(request, reply);
      return options.games.move(principal, request.body);
    },
  );
}
