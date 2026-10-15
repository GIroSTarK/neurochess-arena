import {
  aiErrorResponseSchema,
  type GameErrorCode,
  gameErrorResponseSchema,
} from "@neurochess/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";

import { handleRateLimitError } from "../limits/http.js";
import { gameErrorMessages } from "../locales/en.js";

import { AiTurnError, GameConflictError, GameRequestError } from "./errors.js";

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

export const gameErrorResponses = {
  400: gameErrorResponseSchema,
  401: gameErrorResponseSchema,
  403: gameErrorResponseSchema,
  404: gameErrorResponseSchema,
  409: gameErrorResponseSchema,
  422: gameErrorResponseSchema,
  500: gameErrorResponseSchema,
};

export function handleGameError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (handleRateLimitError(error, request, reply)) return;
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
}

function isClientError(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("statusCode" in error)) return false;
  return typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500;
}
