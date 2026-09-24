import { GAME_IDENTITY_HEADER, gameIdentityContextSchema } from "@neurochess/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";

import { AuthRequestError } from "../auth/errors.js";
import { AUTH_COOKIE_NAME } from "../auth/service.js";
import { GameRequestError } from "../games/errors.js";
import type { createGuestRequestIdentity } from "../guests/http.js";

import type { createAccountIdentityResolver } from "./account.js";
import type { Principal } from "./principal.js";

export function createPublicGameIdentity(
  guestIdentity: ReturnType<typeof createGuestRequestIdentity>,
  accountIdentity?: ReturnType<typeof createAccountIdentityResolver>,
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<Principal> => {
    const context = gameIdentityContextSchema.safeParse(request.headers[GAME_IDENTITY_HEADER]);
    if (!context.success) throw new GameRequestError("INVALID_REQUEST");
    try {
      const account = await accountIdentity?.(request);
      if (account) return account;
    } catch (error: unknown) {
      if (error instanceof AuthRequestError && error.statusCode === 401) {
        throw new GameRequestError("UNAUTHORIZED");
      }
      // Auth failures never fall back or expose library diagnostics through the game logger.
      throw new GameRequestError("INTERNAL_SERVER_ERROR");
    }
    if (context.data === "account" || Object.hasOwn(request.cookies, AUTH_COOKIE_NAME)) {
      throw new GameRequestError("UNAUTHORIZED");
    }
    return guestIdentity.authenticate(request, reply);
  };
}
