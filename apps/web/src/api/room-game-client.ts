import {
  gameErrorResponseSchema,
  gameParamsSchema,
  gamePgnResponseSchema,
  gameReplayResponseSchema,
  gameSnapshotSchema,
  lifecycleCommandSchema,
  moveCommandSchema,
  roomInvitationRequestSchema,
  roomIssuedResponseSchema,
  type RoomView,
  roomViewSchema,
} from "@neurochess/contracts";
import type { z } from "zod";

import { ApiFailure } from "./failures";
import type { GameCommandApi } from "./game-command-api";
import { pgnFor, replayFor, snapshotFor } from "./game-validation";
import { apiOrigin, createHttpRequest, validated } from "./http";
import type { PublicIdentity } from "./identity";

export interface RoomGameApi extends Pick<GameCommandApi, "move" | "lifecycle" | "replay" | "pgn"> {
  read(gameId: string, signal: AbortSignal): Promise<RoomView>;
  invitation(
    command: z.infer<typeof roomInvitationRequestSchema>,
    signal: AbortSignal,
  ): Promise<z.infer<typeof roomIssuedResponseSchema>>;
}

export function roomViewFor(room: RoomView, gameId: string) {
  snapshotFor(room.snapshot, gameId);
  return room;
}

export function createRoomGameApi(
  baseUrl: string,
  identity: PublicIdentity,
  fetcher?: typeof fetch,
): RoomGameApi {
  const input = <T>(schema: z.ZodType<T>, value: unknown) =>
    validated(schema, value, () => new ApiFailure("malformed"));
  const request = createHttpRequest({
    baseUrl: apiOrigin(baseUrl, () => new ApiFailure("malformed")),
    ...(fetcher ? { fetch: fetcher } : {}),
    signal: identity.signal,
    headers: {
      "x-neurochess-identity": identity.intent,
      ...(identity.expectedAccount
        ? { "x-neurochess-expected-account": identity.expectedAccount }
        : {}),
    },
    beforeRequest: () => identity.verify(),
    afterResponse: () => identity.verify(),
    errors: {
      schema: gameErrorResponseSchema,
      failure: (kind) => new ApiFailure(kind),
      isFailure: (error): error is ApiFailure => error instanceof ApiFailure,
      fromResponse(error, gameId: string | undefined) {
        if (error.code === "UNAUTHORIZED" || error.code === "PROFILE_REQUIRED") identity.lost?.();
        return new ApiFailure(
          "api",
          error.code,
          error.code === "GAME_CONFLICT" ? snapshotFor(error.currentSnapshot, gameId) : undefined,
        );
      },
    },
  });
  const id = (gameId: string) => input(gameParamsSchema, { gameId }).gameId.toLowerCase();
  return {
    async read(gameId, signal) {
      const key = id(gameId);
      return roomViewFor(
        await request(`/rooms/${key}`, roomViewSchema, signal, undefined, { errorContext: key }),
        key,
      );
    },
    async move(command, signal) {
      const key = id(command.gameId);
      return snapshotFor(
        await request(
          `/games/${key}/moves`,
          gameSnapshotSchema,
          signal,
          input(moveCommandSchema, command),
          { errorContext: key },
        ),
        key,
      );
    },
    async lifecycle(command, signal) {
      const key = id(command.gameId);
      if (command.action !== "resign" && command.action !== "abort") {
        throw new ApiFailure("malformed");
      }
      return snapshotFor(
        await request(
          `/games/${key}/lifecycle`,
          gameSnapshotSchema,
          signal,
          input(lifecycleCommandSchema, command),
          { errorContext: key },
        ),
        key,
      );
    },
    async invitation(command, signal) {
      const key = id(command.gameId);
      const issued = await request(
        `/rooms/${key}/invitation`,
        roomIssuedResponseSchema,
        signal,
        input(roomInvitationRequestSchema, command),
        { errorContext: key },
      );
      roomViewFor(issued.room, key);
      return issued;
    },
    async replay(gameId, signal) {
      const key = id(gameId);
      return replayFor(
        await request(`/games/${key}/replay`, gameReplayResponseSchema, signal, undefined, {
          errorContext: key,
        }),
        key,
      );
    },
    async pgn(gameId, signal) {
      const key = id(gameId);
      return pgnFor(
        await request(`/games/${key}/pgn`, gamePgnResponseSchema, signal, undefined, {
          errorContext: key,
        }),
        key,
      );
    },
  };
}
