import type { GameReader, GameTransaction } from "@neurochess/database";

import { GameRequestError } from "../games/errors.js";

import { isGuestPrincipal, type Principal } from "./principal.js";

export async function requireActivePrincipal(
  reader: GameReader,
  principal: Principal,
): Promise<void> {
  if (!isGuestPrincipal(principal) || !(await reader.getGuest(principal.guestSessionId))) {
    throw new GameRequestError("UNAUTHORIZED");
  }
}

// Lock identity before game, even for expired-session cleanup. Callers accepting user
// commands must require true; the repository rechecks validity after the lock wait.
export async function lockPrincipal(tx: GameTransaction, principal: Principal): Promise<boolean> {
  return (
    isGuestPrincipal(principal) && (await tx.lockGuest(principal.guestSessionId)) !== undefined
  );
}
