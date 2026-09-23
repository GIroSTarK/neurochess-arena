import type { FastifyRequest } from "fastify";

import { AuthRequestError } from "../auth/errors.js";
import { AUTH_COOKIE_NAME, type AuthService } from "../auth/service.js";

import type { AccountPrincipal } from "./principal.js";

export function createAccountIdentityResolver(auth: AuthService) {
  return async (
    request: Pick<FastifyRequest, "cookies" | "headers">,
  ): Promise<AccountPrincipal | null> => {
    if (!Object.hasOwn(request.cookies, AUTH_COOKIE_NAME)) return null;
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: request.headers.cookie ?? "" }),
      query: { disableCookieCache: true, disableRefresh: true },
    });
    // Null is reserved for absent account credentials; invalid credentials must not fall back to guests.
    if (!session) throw new AuthRequestError(401);
    return { kind: "account", userId: session.user.id, sessionId: session.session.id };
  };
}
