import {
  createRoomRequestSchema,
  emptyQuerySchema,
  gameParamsSchema,
  roomCreationOperationRequestSchema,
  roomCreationOperationSchema,
  type RoomErrorCode,
  roomErrorResponseSchema,
  roomInvitationRequestSchema,
  roomIssuedResponseSchema,
  roomJoinRequestSchema,
  roomResolutionRequestSchema,
  roomResolutionSchema,
  roomViewSchema,
} from "@neurochess/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { AccountAuth } from "../auth/service.js";
import { GameRequestError } from "../games/errors.js";
import { handleGameError } from "../games/http.js";
import type { GuestService } from "../guests/service.js";
import { publicPrincipalFor } from "../identity/http.js";
import { roomErrorMessages } from "../locales/en.js";

import { RoomRequestError } from "./errors.js";
import type { RoomService } from "./service.js";

export interface RoomApiOptions {
  readonly rooms: RoomService;
  readonly guests: GuestService;
  readonly auth?: AccountAuth;
  readonly webOrigin: string;
}

const statuses = {
  ROOM_OPERATION_UNAVAILABLE: 409,
  ROOM_OPERATION_CONFLICT: 409,
  ROOM_UNAVAILABLE: 409,
  ROOM_SELF_JOIN: 409,
  ROOM_ACCOUNT_UNVERIFIED: 403,
  RATE_LIMITED: 429,
} as const satisfies Record<RoomErrorCode, number>;
const errors = {
  400: roomErrorResponseSchema,
  401: roomErrorResponseSchema,
  403: roomErrorResponseSchema,
  404: roomErrorResponseSchema,
  409: roomErrorResponseSchema,
  429: roomErrorResponseSchema,
  500: roomErrorResponseSchema,
};

export async function registerRoomRoutes(app: FastifyInstance, options: RoomApiOptions) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const principal = (request: FastifyRequest, reply: FastifyReply, accountOnly = false) =>
    publicPrincipalFor(options, request, reply, accountOnly);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    if (request.method === "POST" && request.headers.origin !== options.webOrigin) {
      throw new GameRequestError("FORBIDDEN");
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (!(error instanceof RoomRequestError)) return handleGameError(error, request, reply);
    if (error.code === "RATE_LIMITED") reply.header("Retry-After", "60");
    return reply.code(statuses[error.code]).send(
      roomErrorResponseSchema.parse({
        code: error.code,
        message: roomErrorMessages[error.code],
        requestId: request.id,
      }),
    );
  });

  routes.post(
    "/rooms/creation-operation",
    {
      bodyLimit: 1024,
      schema: {
        body: roomCreationOperationRequestSchema,
        querystring: emptyQuerySchema,
        response: { 200: roomCreationOperationSchema, ...errors },
      },
    },
    async (request, reply) =>
      options.rooms.issueCreationOperation(await principal(request, reply, true)),
  );

  routes.post(
    "/rooms",
    {
      bodyLimit: 1024,
      schema: {
        body: createRoomRequestSchema,
        querystring: emptyQuerySchema,
        response: { 200: roomIssuedResponseSchema, ...errors },
      },
    },
    async (request, reply) =>
      options.rooms.create(await principal(request, reply, true), request.body),
  );

  routes.post(
    "/rooms/invitations/resolve",
    {
      bodyLimit: 1024,
      schema: {
        body: roomResolutionRequestSchema,
        querystring: emptyQuerySchema,
        response: { 200: roomResolutionSchema, ...errors },
      },
    },
    async (request) => options.rooms.resolve(request.body),
  );

  routes.post(
    "/rooms/join",
    {
      bodyLimit: 1024,
      schema: {
        body: roomJoinRequestSchema,
        querystring: emptyQuerySchema,
        response: { 200: roomViewSchema, ...errors },
      },
    },
    async (request, reply) => options.rooms.join(await principal(request, reply), request.body),
  );

  routes.post(
    "/rooms/:gameId/invitation",
    {
      bodyLimit: 1024,
      schema: {
        params: gameParamsSchema,
        body: roomInvitationRequestSchema,
        querystring: emptyQuerySchema,
        response: { 200: roomIssuedResponseSchema, ...errors },
      },
    },
    async (request, reply) => {
      if (request.params.gameId.toLowerCase() !== request.body.gameId.toLowerCase()) {
        throw new GameRequestError("INVALID_REQUEST");
      }
      return options.rooms.invitation(await principal(request, reply), request.body);
    },
  );

  routes.get(
    "/rooms/:gameId",
    {
      schema: {
        params: gameParamsSchema,
        querystring: emptyQuerySchema,
        response: { 200: roomViewSchema, ...errors },
      },
    },
    async (request, reply) =>
      options.rooms.read(await principal(request, reply), request.params.gameId),
  );
}
