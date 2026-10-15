import { expectedAccountSchema, gameIdentityIntentSchema } from "@neurochess/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";

import { AUTH_COOKIE_PREFIX } from "../auth/constants.js";
import type { AccountAuth } from "../auth/service.js";
import { GameRequestError } from "../games/errors.js";
import { authenticateGuestRequest } from "../guests/http.js";
import type { GuestService } from "../guests/service.js";
import { enforcePrincipalLimit } from "../limits/http.js";

import type { Principal } from "./principal.js";

export async function publicPrincipalFor(
  options: { auth?: AccountAuth; guests: GuestService },
  request: FastifyRequest,
  reply: FastifyReply,
  accountOnly = false,
): Promise<Principal> {
  const intent = gameIdentityIntentSchema.safeParse(request.headers["x-neurochess-identity"]);
  const expected = expectedAccountSchema.safeParse(
    request.headers["x-neurochess-expected-account"],
  );
  if (!intent.success || !expected.success) throw new GameRequestError("INVALID_REQUEST");
  const account = await options.auth?.resolve(
    new Headers(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
  );
  // This assertion can only deny authority derived from the cookie, never grant it.
  if (expected.data !== undefined && expected.data !== (account?.userId ?? "guest")) {
    throw new GameRequestError("UNAUTHORIZED");
  }
  if (account) {
    enforcePrincipalLimit(request, account);
    return account;
  }
  if (accountOnly) throw new GameRequestError("UNAUTHORIZED");
  const hasAccountCookie = Object.keys(request.cookies).some(
    (name) =>
      name === `__Secure-${AUTH_COOKIE_PREFIX}.session_token` ||
      name === `${AUTH_COOKIE_PREFIX}.session_token`,
  );
  if (intent.data === "account" || (hasAccountCookie && intent.data !== "guest")) {
    throw new GameRequestError("UNAUTHORIZED");
  }
  return authenticateGuestRequest(options.guests, request, reply);
}
