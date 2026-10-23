import { randomUUID } from "node:crypto";

import { createGame } from "@neurochess/chess";
import {
  createRoomRequestSchema,
  type RoomCreationOperation,
  roomCreationOperationSchema,
  roomInvitationRequestSchema,
  type RoomIssuedResponse,
  roomJoinRequestSchema,
  type RoomResolution,
  roomResolutionRequestSchema,
  type RoomView,
  roomViewSchema,
} from "@neurochess/contracts";
import type {
  GameRepository,
  GameStateTransaction,
  IdentityReader,
  IdentityTransaction,
  RoomReader,
  RoomTransaction,
  StoredGame,
  StoredRoom,
} from "@neurochess/database";
import type { z } from "zod";

import { authorizeGameControl, occupiesSeat, ownerOf } from "../games/authorization.js";
import { persistCommand, positionOf, transportSnapshot } from "../games/command-persistence.js";
import { GameConflictError, GameIntegrityError, GameRequestError } from "../games/errors.js";
import { type GameRestorationReader, restoreAuthorizedGame } from "../games/restoration.js";
import type { AccountPrincipal, Principal } from "../identity/principal.js";
import { lockPrincipal, requireActivePrincipal } from "../identity/validity.js";
import type { RoomEvents } from "../realtime/room-events.js";

import { RoomRequestError } from "./errors.js";
import { invitationDigest, issueInvitation, matchesInvitation } from "./invitations.js";

export interface RoomService {
  authorize(principal: Principal, gameId?: string): Promise<void>;
  issueCreationOperation(principal: Principal): Promise<RoomCreationOperation>;
  create(principal: Principal, input: unknown): Promise<RoomIssuedResponse>;
  resolve(input: unknown): Promise<RoomResolution>;
  join(principal: Principal, input: unknown): Promise<RoomView>;
  invitation(principal: Principal, input: unknown): Promise<RoomIssuedResponse>;
  read(principal: Principal, gameId: string): Promise<RoomView>;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new GameRequestError("INVALID_REQUEST");
  return parsed.data;
}

function account(principal: Principal): AccountPrincipal {
  if (principal.kind !== "account") throw new GameRequestError("UNAUTHORIZED");
  return principal;
}

type RoomPrincipalReader = IdentityReader & Pick<RoomReader, "isVerifiedRoomAccount">;

async function requireRoomPrincipal(reader: RoomPrincipalReader, principal: Principal) {
  await requireActivePrincipal(reader, principal);
  if (principal.kind === "account" && !(await reader.isVerifiedRoomAccount(principal.userId))) {
    throw new RoomRequestError("ROOM_ACCOUNT_UNVERIFIED");
  }
}

async function prepare(
  tx: IdentityTransaction & Pick<RoomTransaction, "lockSharedRooms" | "isVerifiedRoomAccount">,
  principal: Principal,
) {
  await tx.lockSharedRooms();
  if (!(await lockPrincipal(tx, principal))) throw new GameRequestError("UNAUTHORIZED");
  await requireRoomPrincipal(tx, principal);
}

async function requireOperation(
  tx: Pick<RoomReader, "getLiveRoomCreationOperation">,
  userId: string,
  operationId: string,
) {
  const operation = await tx.getLiveRoomCreationOperation(userId, operationId);
  if (!operation) throw new RoomRequestError("ROOM_OPERATION_UNAVAILABLE");
  return operation;
}

async function requireFreeSlot(
  tx: RoomPrincipalReader &
    GameRestorationReader &
    Pick<GameStateTransaction, "findUnfinishedAccountGame" | "findUnfinishedGame" | "lockGame">,
  principal: Principal,
) {
  const occupied =
    principal.kind === "account"
      ? await tx.findUnfinishedAccountGame(principal.userId)
      : await tx.findUnfinishedGame(principal.guestSessionId, "ordinary");
  if (!occupied) return;
  const stored = await tx.lockGame(occupied.id);
  await requireRoomPrincipal(tx, principal);
  if (!stored) throw new GameIntegrityError();
  throw new GameConflictError((await restoreAuthorizedGame(tx, principal, stored, false)).snapshot);
}

async function project(
  reader: GameRestorationReader & Pick<IdentityReader, "getAccountUsername">,
  principal: Principal,
  stored: StoredGame,
): Promise<RoomView> {
  if (stored.mode !== "human_vs_human") throw new GameRequestError("NOT_FOUND");
  const restored = await restoreAuthorizedGame(reader, principal, stored, false);
  const room = await reader.getRoom(stored.id);
  const seat = restored.participants.find((seat) => occupiesSeat(principal, seat));
  if (!room || !seat) throw new GameIntegrityError();
  const isOwner = principal.kind === "account" && stored.ownerUserId === principal.userId;
  const waiting = room.state === "waiting" && stored.state === "paused";
  const playing = room.state === "joined" && stored.state === "active";
  const players: Record<string, unknown> = {};
  for (const seat of restored.participants) {
    players[seat.color] = seat.userId
      ? { kind: "account", username: await reader.getAccountUsername(seat.userId) }
      : seat.guestSessionId
        ? { kind: "guest" }
        : room.state === "waiting" && seat.color !== room.ownerColor
          ? { kind: "unassigned" }
          : { kind: "deleted" };
  }
  const result = roomViewSchema.safeParse({
    snapshot: restored.snapshot,
    ownerColor: room.ownerColor,
    state: room.state,
    invitationAvailable: waiting && room.invitationDigest !== null,
    players,
    viewer: { color: seat.color, isOwner },
    capabilities: {
      canMove: playing && seat.color === restored.snapshot.turn,
      canResign: playing,
      canClose: isOwner && (waiting || playing),
      canManageInvitation: isOwner && waiting,
    },
  });
  if (!result.success) throw new GameIntegrityError();
  return result.data;
}

function joinable(room: StoredRoom, stored: StoredGame | undefined): stored is StoredGame {
  return (
    room.state === "waiting" &&
    room.invitationDigest !== null &&
    stored?.mode === "human_vs_human" &&
    stored.state === "paused"
  );
}

export function createRoomService(
  repository: Pick<GameRepository, "read" | "write" | "hasCurrentRoomAccess">,
  events?: RoomEvents,
): RoomService {
  return {
    async authorize(principal, gameId) {
      await repository.read((reader) => requireRoomPrincipal(reader, principal));
      if (gameId === undefined) return;
      const identity =
        principal.kind === "account"
          ? { userId: principal.userId, sessionId: principal.sessionId }
          : { guestSessionId: principal.guestSessionId };
      if (!(await repository.hasCurrentRoomAccess(gameId, identity))) {
        throw new GameRequestError("UNAUTHORIZED");
      }
    },
    issueCreationOperation(principal) {
      const owner = account(principal);
      return repository.write(async (tx) => {
        await prepare(tx, owner);
        const operation = await tx.issueRoomCreationOperation(owner.userId, randomUUID());
        await requireRoomPrincipal(tx, owner);
        return roomCreationOperationSchema.parse({
          operationId: operation.operationId,
          expiresAt: operation.expiresAt.toISOString(),
        });
      });
    },
    create(principal, input) {
      const owner = account(principal);
      const command = parse(createRoomRequestSchema, input);
      const operationId = command.operationId.toLowerCase();
      return repository.write(async (tx) => {
        await prepare(tx, owner);
        const operation = await requireOperation(tx, owner.userId, operationId);
        if (operation.state === "consumed") {
          if (operation.ownerColor !== command.ownerColor) {
            throw new RoomRequestError("ROOM_OPERATION_CONFLICT");
          }
          const stored = operation.gameId ? await tx.lockGame(operation.gameId) : undefined;
          await requireRoomPrincipal(tx, owner);
          await requireOperation(tx, owner.userId, operationId);
          if (!stored || !(await tx.hasRetainedRoomAccess(stored.id, owner.userId))) {
            throw new RoomRequestError("ROOM_OPERATION_UNAVAILABLE");
          }
          const room = await project(tx, owner, stored);
          await requireRoomPrincipal(tx, owner);
          await requireOperation(tx, owner.userId, operationId);
          return { room, invitation: null };
        }
        await requireFreeSlot(tx, owner);
        const game = createGame();
        if (!game.start().ok || !game.pause().ok) throw new GameIntegrityError();
        const snapshot = transportSnapshot(randomUUID(), 0, game.snapshot());
        await tx.insertGame(
          {
            id: snapshot.gameId,
            ownerUserId: owner.userId,
            mode: "human_vs_human",
            ...positionOf(snapshot),
          },
          (["white", "black"] as const).map((color) => ({
            gameId: snapshot.gameId,
            color,
            seatType: "human",
            userId: color === command.ownerColor ? owner.userId : null,
          })),
        );
        const issued = issueInvitation();
        await tx.insertRoom({
          gameId: snapshot.gameId,
          ownerColor: command.ownerColor,
          state: "waiting",
          invitationDigest: issued.digest,
        });
        await tx.consumeRoomCreationOperation(owner.userId, command.ownerColor, snapshot.gameId);
        const stored = await tx.getGame(snapshot.gameId);
        if (!stored) throw new GameIntegrityError();
        const room = await project(tx, owner, stored);
        await requireRoomPrincipal(tx, owner);
        await requireOperation(tx, owner.userId, operationId);
        return { room, invitation: issued.invitation };
      });
    },
    resolve(input) {
      const { invitation } = parse(roomResolutionRequestSchema, input);
      const digest = invitationDigest(invitation);
      return repository.read(async (reader) => {
        const room = await reader.findRoomInvitation(digest);
        return {
          status:
            room &&
            matchesInvitation(digest, room.invitationDigest) &&
            joinable(room, await reader.getGame(room.gameId))
              ? "joinable"
              : "unavailable",
        };
      });
    },
    async join(principal, input) {
      const command = parse(roomJoinRequestSchema, input);
      const commandId = command.commandId.toLowerCase();
      const digest = invitationDigest(command.invitation);
      const view = await repository.write(async (tx) => {
        await prepare(tx, principal);
        const receipt = await tx.findRoomJoin(commandId);
        if (receipt) {
          if (!matchesInvitation(digest, receipt.joinedInvitationDigest)) {
            throw new RoomRequestError("ROOM_UNAVAILABLE");
          }
          const stored = await tx.lockGame(receipt.gameId);
          await requireRoomPrincipal(tx, principal);
          const seats = await tx.getParticipants(receipt.gameId);
          if (
            !stored ||
            !seats.some(
              (seat) => seat.color !== receipt.ownerColor && occupiesSeat(principal, seat),
            )
          ) {
            throw new RoomRequestError("ROOM_UNAVAILABLE");
          }
          const view = await project(tx, principal, stored);
          await requireRoomPrincipal(tx, principal);
          return view;
        }
        const room = await tx.findRoomInvitation(digest);
        if (!room || !matchesInvitation(digest, room.invitationDigest)) {
          throw new RoomRequestError("ROOM_UNAVAILABLE");
        }
        const candidate = await tx.getGame(room.gameId);
        if (!joinable(room, candidate)) throw new RoomRequestError("ROOM_UNAVAILABLE");
        if (principal.kind === "account" && principal.userId === candidate.ownerUserId) {
          throw new RoomRequestError("ROOM_SELF_JOIN");
        }
        // The gate stabilizes admission; check an occupied slot before locking the target game.
        await requireFreeSlot(tx, principal);
        const stored = await tx.lockGame(room.gameId);
        await requireRoomPrincipal(tx, principal);
        if (!joinable(room, stored)) throw new RoomRequestError("ROOM_UNAVAILABLE");
        if (await tx.hasCommand(stored.id, commandId)) {
          throw new RoomRequestError("ROOM_UNAVAILABLE");
        }
        // Validate the canonical waiting position internally before granting the second seat.
        const restored = await restoreAuthorizedGame(tx, ownerOf(stored), stored, false);
        const active = restored.game.resume();
        if (!active.ok) throw new GameIntegrityError();
        const identity =
          principal.kind === "account"
            ? { userId: principal.userId }
            : { guestSessionId: principal.guestSessionId };
        await tx.seatRoomParticipant(
          stored.id,
          room.ownerColor === "white" ? "black" : "white",
          identity,
        );
        await tx.reserveGameSlot({ gameId: stored.id, scope: "ordinary", ...identity });
        await tx.acceptRoomJoin(stored.id, commandId, digest);
        await persistCommand(tx, stored, commandId, "room_join", active.value);
        const joined = await tx.getGame(stored.id);
        if (!joined) throw new GameIntegrityError();
        const view = await project(tx, principal, joined);
        await requireRoomPrincipal(tx, principal);
        return view;
      });
      events?.publish(view.snapshot.gameId);
      return view;
    },
    async invitation(principal, input) {
      const command = parse(roomInvitationRequestSchema, input);
      const issued = await repository.write(async (tx) => {
        await prepare(tx, principal);
        const stored = await tx.lockGame(command.gameId);
        await requireRoomPrincipal(tx, principal);
        if (!stored) throw new GameRequestError("NOT_FOUND");
        const current = await project(tx, principal, stored);
        if (
          command.expectedVersion !== stored.version ||
          (await tx.hasCommand(stored.id, command.commandId.toLowerCase()))
        ) {
          throw new GameConflictError(current.snapshot);
        }
        authorizeGameControl(principal, stored);
        if (!current.capabilities.canManageInvitation) {
          throw new GameRequestError("INVALID_GAME_STATE");
        }
        const issued = command.action === "replace" ? issueInvitation() : null;
        await tx.setRoomInvitation(stored.id, issued?.digest ?? null);
        await persistCommand(
          tx,
          stored,
          command.commandId.toLowerCase(),
          command.action === "replace" ? "invitation_replace" : "invitation_revoke",
          current.snapshot,
        );
        const updated = await tx.getGame(stored.id);
        if (!updated) throw new GameIntegrityError();
        const room = await project(tx, principal, updated);
        await requireRoomPrincipal(tx, principal);
        return { room, invitation: issued?.invitation ?? null };
      });
      events?.publish(issued.room.snapshot.gameId);
      return issued;
    },
    read(principal, gameId) {
      return repository.read(async (reader) => {
        await requireRoomPrincipal(reader, principal);
        const stored = await reader.getGame(gameId);
        if (!stored) throw new GameRequestError("NOT_FOUND");
        return project(reader, principal, stored);
      });
    },
  };
}
