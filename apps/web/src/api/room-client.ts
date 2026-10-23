import {
  createRoomRequestSchema,
  type GameErrorCode,
  guestSessionResponseSchema,
  roomCreationOperationSchema,
  type RoomErrorCode,
  roomErrorResponseSchema,
  roomIssuedResponseSchema,
  roomJoinRequestSchema,
  roomResolutionRequestSchema,
  roomResolutionSchema,
  type RoomView,
  roomViewSchema,
  unfinishedGameDetailsSchema,
} from "@neurochess/contracts";
import type { z } from "zod";

import type { ApiFailureKind } from "./failures";
import { snapshotFor } from "./game-validation";
import { apiOrigin, createHttpRequest, validated as validate } from "./http";
import type { PublicIdentity } from "./identity";

export class RoomFailure extends Error {
  constructor(
    readonly kind: ApiFailureKind,
    readonly code?: GameErrorCode | RoomErrorCode,
  ) {
    super(kind);
    this.name = "RoomFailure";
  }
}

function validated<T>(schema: z.ZodType<T>, value: unknown) {
  return validate(schema, value, () => new RoomFailure("malformed"));
}

function roomFor(room: RoomView): RoomView {
  try {
    snapshotFor(room.snapshot);
    return room;
  } catch {
    throw new RoomFailure("malformed");
  }
}

export function createRoomApi(
  baseUrl: string,
  options: { fetch?: typeof fetch; identity?: PublicIdentity } = {},
) {
  const { identity } = options;
  const request = createHttpRequest({
    baseUrl: apiOrigin(baseUrl, () => new RoomFailure("malformed")),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(identity
      ? {
          signal: identity.signal,
          headers: {
            "x-neurochess-identity": identity.intent,
            ...(identity.expectedAccount
              ? { "x-neurochess-expected-account": identity.expectedAccount }
              : {}),
          },
          beforeRequest: () => identity.verify(),
          afterResponse: () => identity.verify(),
        }
      : {}),
    errors: {
      schema: roomErrorResponseSchema,
      failure: (kind) => new RoomFailure(kind),
      isFailure: (error): error is RoomFailure => error instanceof RoomFailure,
      fromResponse(error) {
        if (error.code === "UNAUTHORIZED" || error.code === "PROFILE_REQUIRED") identity?.lost?.();
        return new RoomFailure("api", error.code);
      },
    },
  });
  function requireIdentity(account = false) {
    if (!identity || (account && identity.intent !== "account")) {
      throw new RoomFailure("api", "UNAUTHORIZED");
    }
  }

  return {
    async operation(signal: AbortSignal) {
      requireIdentity(true);
      return request("/rooms/creation-operation", roomCreationOperationSchema, signal, {});
    },
    async create(input: z.infer<typeof createRoomRequestSchema>, signal: AbortSignal) {
      requireIdentity(true);
      const issued = await request(
        "/rooms",
        roomIssuedResponseSchema,
        signal,
        validated(createRoomRequestSchema, input),
      );
      roomFor(issued.room);
      return issued;
    },
    async resolve(invitation: string, signal: AbortSignal) {
      return request(
        "/rooms/invitations/resolve",
        roomResolutionSchema,
        signal,
        validated(roomResolutionRequestSchema, { invitation }),
      );
    },
    async bootstrap(signal: AbortSignal) {
      requireIdentity();
      if (identity?.intent === "guest") {
        await request("/guest-session", guestSessionResponseSchema, signal, {});
      }
    },
    async join(input: z.infer<typeof roomJoinRequestSchema>, signal: AbortSignal) {
      requireIdentity();
      return roomFor(
        await request(
          "/rooms/join",
          roomViewSchema,
          signal,
          validated(roomJoinRequestSchema, input),
        ),
      );
    },
    async unfinished(signal: AbortSignal) {
      requireIdentity();
      const { game } = await request("/games/unfinished", unfinishedGameDetailsSchema, signal);
      return game?.snapshot.gameId ?? null;
    },
  };
}

export type RoomApi = ReturnType<typeof createRoomApi>;
