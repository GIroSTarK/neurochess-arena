import { type GameSnapshot, gameSnapshotSchema } from "@neurochess/contracts";
import type { GameReader, StoredMove } from "@neurochess/database";

import { GameIntegrityError } from "./errors.js";

/** Call only after read authorization, within the snapshot's transaction. */
export async function withInvocations(
  reader: GameReader,
  snapshot: GameSnapshot,
  moves?: readonly StoredMove[],
): Promise<GameSnapshot> {
  const invocations = await reader.getModelInvocations(snapshot.gameId);
  if (invocations.length === 0) return snapshot;
  const reservations = await reader.getTurnReservations(snapshot.gameId);
  const history = moves ?? (await reader.getMoves(snapshot.gameId));
  const reservationById = new Map(reservations.map((reservation) => [reservation.id, reservation]));
  const moveByCommand = new Map(history.map((move) => [move.commandId, move]));
  const ordered = invocations
    .map((invocation) => {
      const reservation = reservationById.get(invocation.reservationId);
      if (!reservation || reservation.expectedVersion > snapshot.version) {
        throw new GameIntegrityError();
      }
      return { invocation, reservation };
    })
    .sort(
      (a, b) =>
        a.reservation.expectedVersion - b.reservation.expectedVersion ||
        a.invocation.attempt - b.invocation.attempt,
    );
  let moveIndex = 0;
  let attempt = 0;
  let previousPly = 0;
  const projected = ordered.map(({ invocation, reservation }) => {
    while ((history[moveIndex]?.version ?? Infinity) <= reservation.expectedVersion) {
      moveIndex++;
    }
    const ply = moveIndex + 1;
    attempt = ply === previousPly ? attempt + 1 : 1;
    previousPly = ply;
    const move = moveByCommand.get(reservation.commandId);
    const accepted = invocation.status === "succeeded" && move !== undefined;
    if (
      accepted &&
      (reservation.status !== "committed" || move.ply !== ply || move.uci !== invocation.move)
    ) {
      throw new GameIntegrityError();
    }
    // Project an allowlist; reservation identities, provider request IDs, and diagnostics stay internal.
    return {
      ply,
      color: reservation.color,
      attempt,
      status: invocation.status,
      accepted,
      commentary: accepted ? invocation.commentary : null,
      latencyMs: invocation.latencyMs,
      usage: {
        inputTokens: invocation.inputTokens,
        outputTokens: invocation.outputTokens,
        totalTokens: invocation.totalTokens,
      },
      error:
        invocation.errorKind === "model_invalid"
          ? { kind: invocation.errorKind, reason: invocation.invalidReason }
          : invocation.errorKind
            ? { kind: invocation.errorKind }
            : null,
    };
  });
  const result = gameSnapshotSchema.safeParse({ ...snapshot, invocations: projected });
  if (!result.success) throw new GameIntegrityError();
  return result.data;
}
