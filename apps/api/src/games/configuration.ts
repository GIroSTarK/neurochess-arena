import { type AiGameConfiguration, aiGameConfigurationSchema } from "@neurochess/contracts";
import type { NewParticipant, StoredGame, StoredParticipant } from "@neurochess/database";

import { GameIntegrityError } from "./errors.js";

export function configurationOf(
  stored: StoredGame,
  participants: readonly StoredParticipant[],
): AiGameConfiguration | null {
  if (stored.mode === null) return null;
  if (stored.isSandbox) throw new GameIntegrityError();

  const seats: Partial<Record<"white" | "black", unknown>> = {};
  for (const participant of participants) {
    if (participant.seatType === "human") {
      if (
        participant.guestSessionId !== stored.ownerGuestSessionId ||
        participant.provider !== null ||
        participant.modelId !== null ||
        participant.parameters !== null
      ) {
        throw new GameIntegrityError();
      }
      seats[participant.color] = { type: "human" };
    } else {
      if (participant.guestSessionId !== null) throw new GameIntegrityError();
      // Parse the stored fields together below; a corrupt row is never repaired or defaulted.
      seats[participant.color] = {
        type: "ai",
        provider: participant.provider,
        modelId: participant.modelId,
        parameters: participant.parameters,
      };
    }
  }
  const configuration = aiGameConfigurationSchema.safeParse({ mode: stored.mode, seats });
  if (!configuration.success) throw new GameIntegrityError();
  return configuration.data;
}

export function participantsFor(
  gameId: string,
  ownerGuestSessionId: string,
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
          guestSessionId: configuration !== null || color === "white" ? ownerGuestSessionId : null,
        };
  });
}
