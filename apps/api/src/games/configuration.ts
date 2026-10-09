import {
  type AiGameConfiguration,
  type GameConfiguration,
  gameConfigurationSchema,
} from "@neurochess/contracts";
import type {
  NewParticipant,
  StoredGame,
  StoredParticipant,
  StoredRoom,
} from "@neurochess/database";

import type { GameIdentity } from "../identity/principal.js";

import { GameIntegrityError } from "./errors.js";

export function configurationOf(
  stored: Pick<
    StoredGame,
    "id" | "mode" | "state" | "isSandbox" | "ownerGuestSessionId" | "ownerUserId"
  >,
  participants: readonly StoredParticipant[],
  room?: StoredRoom,
): GameConfiguration | null {
  if (stored.mode === null) return null;
  if (
    stored.isSandbox ||
    participants.length !== 2 ||
    new Set(participants.map((seat) => seat.color)).size !== 2
  ) {
    throw new GameIntegrityError();
  }
  if (stored.mode === "human_vs_human") {
    const terminal = stored.state === "completed" || stored.state === "aborted";
    const ownerSeat = participants.find((seat) => seat.color === room?.ownerColor);
    const otherSeat = participants.find((seat) => seat.color !== room?.ownerColor);
    if (
      room?.gameId !== stored.id ||
      !["waiting", "joined"].includes(room.state) ||
      (room.invitationDigest !== null && !/^[0-9a-f]{64}$/.test(room.invitationDigest)) ||
      !ownerSeat ||
      !otherSeat ||
      stored.ownerGuestSessionId !== null ||
      (!terminal && stored.ownerUserId === null) ||
      ownerSeat.userId !== stored.ownerUserId ||
      ownerSeat.guestSessionId !== null ||
      participants.some(
        (seat) =>
          seat.seatType !== "human" || (seat.userId !== null && seat.guestSessionId !== null),
      ) ||
      (room.state === "waiting"
        ? (stored.state !== "paused" && stored.state !== "aborted") ||
          room.joinedAt !== null ||
          otherSeat.userId !== null ||
          otherSeat.guestSessionId !== null
        : (!terminal && stored.state !== "active") ||
          !(room.joinedAt instanceof Date) ||
          !Number.isFinite(room.joinedAt.getTime()) ||
          room.invitationDigest !== null ||
          (!terminal && otherSeat.userId === null && otherSeat.guestSessionId === null)) ||
      (terminal && room.invitationDigest !== null)
    ) {
      throw new GameIntegrityError();
    }
  }

  const seats: Partial<Record<"white" | "black", unknown>> = {};
  for (const participant of participants) {
    if (participant.seatType === "human") {
      if (
        (stored.mode !== "human_vs_human" &&
          (participant.guestSessionId !== stored.ownerGuestSessionId ||
            participant.userId !== stored.ownerUserId)) ||
        participant.provider !== null ||
        participant.modelId !== null ||
        participant.parameters !== null
      ) {
        throw new GameIntegrityError();
      }
      seats[participant.color] = { type: "human" };
    } else {
      if (participant.guestSessionId !== null || participant.userId !== null) {
        throw new GameIntegrityError();
      }
      // Parse the stored fields together below; a corrupt row is never repaired or defaulted.
      seats[participant.color] = {
        type: "ai",
        provider: participant.provider,
        modelId: participant.modelId,
        parameters: participant.parameters,
      };
    }
  }
  const configuration = gameConfigurationSchema.safeParse({ mode: stored.mode, seats });
  if (!configuration.success) throw new GameIntegrityError();
  return configuration.data;
}

export function participantsFor(
  gameId: string,
  owner: GameIdentity,
  configuration: AiGameConfiguration | null,
): NewParticipant[] {
  return (["white", "black"] as const).map((color) => {
    const seat = configuration?.seats[color];
    return seat?.type === "ai"
      ? {
          gameId,
          color,
          seatType: "ai",
          guestSessionId: null,
          provider: seat.provider,
          modelId: seat.modelId,
          parameters: seat.parameters,
        }
      : {
          gameId,
          color,
          seatType: "human",
          guestSessionId:
            owner.kind === "guest" && (configuration !== null || color === "white")
              ? owner.guestSessionId
              : null,
          userId: owner.kind === "account" ? owner.userId : null,
        };
  });
}
