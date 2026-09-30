import type { FastifyReply, FastifyRequest } from "fastify";

import type { GuestPrincipal } from "../identity/principal.js";

import { GUEST_COOKIE_NAME, type GuestIdentity, type GuestService } from "./service.js";

export function setGuestCookie(
  reply: FastifyReply,
  identity: GuestIdentity,
  ttlSeconds: number,
): void {
  reply.setCookie(GUEST_COOKIE_NAME, identity.token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: ttlSeconds,
  });
}

export async function authenticateGuestRequest(
  guests: GuestService,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<GuestPrincipal> {
  const identity = await guests.authenticate(request.cookies[GUEST_COOKIE_NAME]);
  setGuestCookie(reply, identity, guests.ttlSeconds);
  return identity.principal;
}
