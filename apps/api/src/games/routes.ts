import {
  aiControllerRequestSchema,
  aiErrorResponseSchema,
  aiGameConfigurationSchema,
  aiTurnRequestSchema,
  createGameRequestSchema,
  emptyQuerySchema,
  expectedAccountSchema,
  gameDetailsSchema,
  type GameErrorCode,
  gameErrorResponseSchema,
  gameIdentityIntentSchema,
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

import { AUTH_COOKIE_PREFIX } from "../auth/constants.js";
import type { AccountAuth } from "../auth/service.js";
import { authenticateGuestRequest, setGuestCookie } from "../guests/http.js";
import { GUEST_COOKIE_NAME, type GuestService } from "../guests/service.js";
import type { Principal } from "../identity/principal.js";
import { gameErrorMessages } from "../locales/en.js";
import {
  AI_TURN_TIMEOUT_MS,
  DISCOVERY_TIMEOUT_MS,
  providerRequestScope,
} from "../providers/request-scope.js";

import { AiTurnError } from "./ai-turn.js";
import { GameConflictError, GameRequestError } from "./errors.js";
import type { GameService } from "./service.js";

export interface GameApiOptions {
  readonly auth?: AccountAuth;
  readonly games: GameService;
  readonly guests: GuestService;
  readonly webOrigin: string;
  readonly providerTimeouts?: { readonly discoveryMs?: number; readonly turnMs?: number };
}

const errorStatuses = {
  INVALID_REQUEST: 400,
  INVALID_UCI: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  PROFILE_REQUIRED: 403,
  NOT_FOUND: 404,
  GAME_CONFLICT: 409,
  INVALID_GAME_STATE: 409,
  ILLEGAL_MOVE: 422,
  INTERNAL_SERVER_ERROR: 500,
} as const satisfies Record<GameErrorCode, number>;

const errorResponses = {
  400: gameErrorResponseSchema,
  401: gameErrorResponseSchema,
  403: gameErrorResponseSchema,
  404: gameErrorResponseSchema,
  409: gameErrorResponseSchema,
  422: gameErrorResponseSchema,
  500: gameErrorResponseSchema,
};

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
  app.addHook("onReady", async () => {
    sweep();
    await sweeping;
  });
  app.addHook("onClose", async () => {
    clearInterval(presenceTimer);
    await sweeping;
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.method === "POST" && request.headers.origin !== options.webOrigin) {
      throw new GameRequestError("FORBIDDEN");
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AiTurnError) {
      return reply
        .code(error.code === "AI_PARAMETERS_INVALID" ? 422 : 409)
        .send(aiErrorResponseSchema.parse({ code: error.code, requestId: request.id }));
    }
    const code: GameErrorCode =
      error instanceof GameRequestError || error instanceof GameConflictError
        ? error.code
        : isClientError(error)
          ? "INVALID_REQUEST"
          : "INTERNAL_SERVER_ERROR";
    if (code === "INTERNAL_SERVER_ERROR") request.log.error({ err: error }, "Game request failed");
    const response = gameErrorResponseSchema.parse({
      code,
      message: gameErrorMessages[code],
      requestId: request.id,
      ...(error instanceof GameConflictError ? { currentSnapshot: error.currentSnapshot } : {}),
    });
    return reply.code(errorStatuses[code]).send(response);
  });

  async function principalFor(request: FastifyRequest, reply: FastifyReply): Promise<Principal> {
    const params = gameParamsSchema.safeParse(request.params);
    // The immutable server-owned marker selects Sandbox authority on shared routes.
    // It never permits guest fallback for an ordinary public game.
    if (params.success && (await options.games.isSandboxGame(params.data.gameId))) {
      return authenticateGuestRequest(options.guests, request, reply);
    }
    const intent = gameIdentityIntentSchema.safeParse(request.headers["x-neurochess-identity"]);
    const expected = expectedAccountSchema.safeParse(
      request.headers["x-neurochess-expected-account"],
    );
    if (!intent.success || !expected.success) throw new GameRequestError("INVALID_REQUEST");
    const account = await options.auth?.resolve(
      new Headers(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
    );
    // This assertion can only deny authority derived from the cookie, never grant it.
    if (expected.data !== undefined && expected.data !== (account?.userId ?? "guest")) {
      throw new GameRequestError("UNAUTHORIZED");
    }
    if (account) return account;
    const hasAccountCookie = Object.keys(request.cookies).some(
      (name) =>
        name === `__Secure-${AUTH_COOKIE_PREFIX}.session_token` ||
        name === `${AUTH_COOKIE_PREFIX}.session_token`,
    );
    if (intent.data === "account" || (hasAccountCookie && intent.data !== "guest")) {
      throw new GameRequestError("UNAUTHORIZED");
    }
    return authenticateGuestRequest(options.guests, request, reply);
  }

  const aiErrors = { ...errorResponses, 409: aiErrorResponseSchema, 422: aiErrorResponseSchema };

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
          apiKey: request.body.apiKey,
          signal: scope.signal,
        });
      } finally {
        request.body.apiKey = "";
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
        response: { 201: gameDetailsSchema, ...errorResponses },
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
        response: { 200: unfinishedGameDetailsSchema, ...errorResponses },
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
        response: { 200: gameDetailsSchema, ...errorResponses },
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
        response: { 200: gameInvocationsSchema, ...errorResponses },
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
            apiKey: request.body.apiKey,
            signal: scope.signal,
          },
        );
      } finally {
        request.body.apiKey = "";
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
        response: { 200: guestSessionResponseSchema, ...errorResponses },
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
        response: { 201: gameSnapshotSchema, ...errorResponses },
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
        response: { 200: unfinishedGameResponseSchema, ...errorResponses },
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
        response: { 200: gameReplayResponseSchema, ...errorResponses },
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
        response: { 200: gamePgnResponseSchema, ...errorResponses },
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
        response: { 200: gameSnapshotSchema, ...errorResponses },
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
        response: { 200: gameSnapshotSchema, ...errorResponses },
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

function isClientError(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("statusCode" in error)) return false;
  return typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500;
}
