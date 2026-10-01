import type { GameReader, GameTransaction } from "@neurochess/database";

import { GameRequestError } from "../games/errors.js";

import { type GameIdentity, isGuestPrincipal, type Principal } from "./principal.js";

async function activePrincipal(reader: GameReader, principal: Principal): Promise<boolean> {
  switch (principal.kind) {
    case "guest":
      return Boolean(await reader.getGuest(principal.guestSessionId));
    case "account":
      return (
        Boolean(principal.userId && principal.sessionId) &&
        (await reader.hasAccountSession(principal.userId, principal.sessionId))
      );
    default:
      return false;
  }
}

export async function requireActivePrincipal(
  reader: GameReader,
  principal: Principal,
): Promise<void> {
  if (!(await activePrincipal(reader, principal))) {
    throw new GameRequestError("UNAUTHORIZED");
  }
}

// Lock identity before game, even for expired-session cleanup. Callers accepting user
// commands must require true; the repository rechecks validity after the lock wait.
export async function lockPrincipal(tx: GameTransaction, principal: Principal): Promise<boolean> {
  await lockIdentity(tx, principal);
  return activePrincipal(tx, principal);
}

export async function lockIdentity(tx: GameTransaction, identity: GameIdentity): Promise<void> {
  if (isGuestPrincipal(identity)) await tx.lockGuest(identity.guestSessionId);
  else if (identity.userId) await tx.lockAccount(identity.userId);
}
