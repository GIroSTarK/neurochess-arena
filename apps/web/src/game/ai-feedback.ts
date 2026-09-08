import type { GameSnapshot } from "@neurochess/contracts";

export function turnInvocations(snapshot: GameSnapshot) {
  return (snapshot.invocations ?? []).filter(
    ({ ply, color }) => ply === snapshot.moves.length + 1 && color === snapshot.turn,
  );
}

export function providerFailure(snapshot: GameSnapshot | null) {
  if (snapshot?.state !== "paused") return null;
  const latest = turnInvocations(snapshot).at(-1);
  return latest?.status === "provider_error" ? latest : null;
}

export function invalidRetries(snapshot: GameSnapshot): number {
  return Math.min(
    2,
    turnInvocations(snapshot).filter(({ error }) => error?.kind === "model_invalid").length,
  );
}
