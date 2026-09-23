import type { GameReader, GameTransaction } from "@neurochess/database";

import { GameRequestError } from "../games/errors.js";

import type { Principal } from "./principal.js";

export async function requireActivePrincipal(
  reader: GameReader,
  principal: Principal,
): Promise<void> {
  if (!(await reader.getGuest(principal.guestSessionId))) {
    throw new GameRequestError("UNAUTHORIZED");
  }
}

export async function lockActivePrincipal(
  tx: GameTransaction,
  principal: Principal,
): Promise<void> {
  // The repository rechecks expiry with the database clock after the identity lock wait.
  if (!(await tx.lockGuest(principal.guestSessionId))) {
    throw new GameRequestError("UNAUTHORIZED");
  }
}

export async function lockPrincipalForCleanup(
  tx: GameTransaction,
  principal: Principal,
): Promise<void> {
  // Maintenance keeps identity-before-game ordering even after access expires.
  // This lock cannot authorize a user command or another provider dispatch.
  await tx.lockGuest(principal.guestSessionId);
}
