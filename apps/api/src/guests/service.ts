import { createHash, randomBytes } from "node:crypto";

import type { GameRepository } from "@neurochess/database";

import { GameRequestError } from "../games/errors.js";

export const GUEST_COOKIE_NAME = "__Host-neurochess_guest";

export interface GuestPrincipal {
  readonly guestSessionId: string;
}

export interface GuestIdentity {
  readonly principal: GuestPrincipal;
  readonly token: string;
}

export interface GuestService {
  readonly ttlSeconds: number;
  bootstrap(token: string | undefined): Promise<GuestIdentity>;
  authenticate(token: string | undefined): Promise<GuestIdentity>;
}

const tokenPattern = /^[A-Za-z0-9_-]{43}(?![\s\S])/;

export function createGuestService(repository: GameRepository, ttlSeconds: number): GuestService {
  async function renew(token: string | undefined): Promise<GuestIdentity | undefined> {
    if (token === undefined || !tokenPattern.test(token)) return undefined;
    const guest = await repository.renewGuest(hashToken(token), ttlSeconds);
    return guest ? { principal: { guestSessionId: guest.id }, token } : undefined;
  }

  return {
    ttlSeconds,
    async bootstrap(token) {
      const existing = await renew(token);
      if (existing) return existing;
      const nextToken = randomBytes(32).toString("base64url");
      const guest = await repository.createGuest(hashToken(nextToken), ttlSeconds);
      return { principal: { guestSessionId: guest.id }, token: nextToken };
    },
    async authenticate(token) {
      const identity = await renew(token);
      if (!identity) throw new GameRequestError("UNAUTHORIZED");
      return identity;
    },
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
