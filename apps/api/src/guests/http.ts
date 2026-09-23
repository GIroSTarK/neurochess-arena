import type { FastifyReply, FastifyRequest } from "fastify";

import { GUEST_COOKIE_NAME, type GuestIdentity, type GuestService } from "./service.js";

export function createGuestRequestIdentity(guests: GuestService) {
  function setCookie(reply: FastifyReply, identity: GuestIdentity): void {
    reply.setCookie(GUEST_COOKIE_NAME, identity.token, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: guests.ttlSeconds,
    });
  }

  return {
    authenticate: async (request: FastifyRequest, reply: FastifyReply) => {
      const identity = await guests.authenticate(request.cookies[GUEST_COOKIE_NAME]);
      setCookie(reply, identity);
      return identity.principal;
    },
    bootstrap: async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const identity = await guests.bootstrap(request.cookies[GUEST_COOKIE_NAME]);
      setCookie(reply, identity);
    },
  };
}
