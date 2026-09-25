import { authSchema, games } from "@neurochess/database";
import { inArray } from "drizzle-orm";

import { integrationDatabase } from "../../../test/database.js";
import { AUTH_COOKIE_NAME, type AuthService, createAuth } from "../src/auth/service.js";
import type { AccountPrincipal } from "../src/identity/principal.js";

import { AUTH_ENVIRONMENT, fixtureAuth, registerFixture } from "./auth-helpers.js";
import { ApiHarness, type TestApi, WEB_ORIGIN } from "./helpers.js";

export class AccountGameHarness extends ApiHarness {
  private readonly userIds = new Set<string>();

  override createApi(options: Parameters<ApiHarness["createApi"]>[0] = {}) {
    return super.createApi({ auth: (db) => createAuth(db, AUTH_ENVIRONMENT), ...options });
  }

  async account(api: TestApi) {
    const auth = fixtureAuth(api.database);
    const account = await registerFixture(auth);
    this.userIds.add(account.userId);
    const principal = await principalFor(auth, account.cookie);
    return { ...account, principal };
  }

  async anotherSession(api: TestApi, account: { email: string; password: string }) {
    const auth = fixtureAuth(api.database);
    const response = await auth.api.signInEmail({ body: account, asResponse: true });
    const cookie = response.headers
      .getSetCookie()
      .find((entry) => entry.startsWith(`${AUTH_COOKIE_NAME}=`))
      ?.split(";")[0];
    if (!cookie) throw new Error("Account session fixture failed");
    return { cookie, principal: await principalFor(auth, cookie) };
  }

  override async dispose() {
    await super.dispose();
    if (!this.userIds.size) return;
    const database = integrationDatabase();
    try {
      await database.db.transaction(async (tx) => {
        await tx.delete(games).where(inArray(games.ownerUserId, [...this.userIds]));
        await tx.delete(authSchema.user).where(inArray(authSchema.user.id, [...this.userIds]));
      });
    } finally {
      this.userIds.clear();
      await database.close();
    }
  }
}

async function principalFor(auth: AuthService, cookie: string): Promise<AccountPrincipal> {
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  if (!session) throw new Error("Account session fixture missing");
  return { kind: "account", userId: session.user.id, sessionId: session.session.id };
}

export function post(
  api: TestApi,
  cookie: string,
  url: string,
  payload: object,
  headers: Record<string, string> = {},
) {
  return api.app.inject({
    method: "POST",
    url,
    payload,
    headers: { origin: WEB_ORIGIN, cookie, ...headers },
  });
}

export function get(
  api: TestApi,
  cookie: string,
  url: string,
  headers: Record<string, string> = {},
) {
  return api.app.inject({ method: "GET", url, headers: { cookie, ...headers } });
}
