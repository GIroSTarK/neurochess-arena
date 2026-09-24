import type { GameOwner, GameReader, GameTransaction } from "@neurochess/database";

import { GameRequestError } from "../games/errors.js";

import type { Principal } from "./principal.js";

export async function requireActivePrincipal(
  reader: GameReader,
  principal: Principal,
): Promise<void> {
  const valid =
    principal.kind === "guest"
      ? await reader.getGuest(principal.guestSessionId)
      : await reader.hasAccountSession(principal.userId, principal.sessionId);
  if (!valid) {
    throw new GameRequestError("UNAUTHORIZED");
  }
}

export async function lockActivePrincipal(
  tx: GameTransaction,
  principal: Principal,
): Promise<void> {
  // The repository rechecks expiry with the database clock after the identity lock wait.
  const valid =
    principal.kind === "guest"
      ? await tx.lockGuest(principal.guestSessionId)
      : await tx.lockAccountSession(principal.userId, principal.sessionId);
  if (!valid) {
    throw new GameRequestError("UNAUTHORIZED");
  }
}

export async function lockPrincipalForCleanup(
  tx: GameTransaction,
  principal: GameOwner,
): Promise<void> {
  // Maintenance keeps identity-before-game ordering even after access expires.
  // This lock cannot authorize a user command or another provider dispatch.
  if (principal.kind === "guest") await tx.lockGuest(principal.guestSessionId);
  else await tx.lockAccount(principal.userId);
}
