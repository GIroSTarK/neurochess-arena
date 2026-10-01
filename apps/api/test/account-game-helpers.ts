import { randomInt, randomUUID } from "node:crypto";

import { gameDetailsSchema } from "@neurochess/contracts";
import { authRateLimits, authUsers, createAuthDatabaseAdapter, games } from "@neurochess/database";
import { betterAuth } from "better-auth/minimal";
import { eq, inArray, like } from "drizzle-orm";
import { expect } from "vitest";
import { z } from "zod";

import { integrationDatabase } from "../../../test/database.js";
import { authOptions } from "../src/auth/options.js";
import { createAccountAuth } from "../src/auth/service.js";

import { aiMatch } from "./ai-turn-helpers.js";
import { ApiHarness, type TestApi, WEB_ORIGIN } from "./helpers.js";

export const authEnvironment = {
  BETTER_AUTH_URL: "http://localhost:3001",
  BETTER_AUTH_SECRET: "account-game-test-only-secret-for-real-auth-fixtures",
  WEB_ORIGIN,
};

export class AccountGameHarness extends ApiHarness {
  private readonly userIds: string[] = [];
  private readonly ip = `198.19.${randomInt(256)}.${randomInt(1, 255)}`;

  createAuthenticatedApi(options: Parameters<ApiHarness["createApi"]>[0] = {}) {
    return this.createApi({
      ...options,
      auth: (database) => createAccountAuth(database, authEnvironment),
    });
  }

  async account(api: TestApi) {
    const fixture = betterAuth({
      ...authOptions(authEnvironment),
      database: createAuthDatabaseAdapter(api.database),
      emailAndPassword: { enabled: true, disableSignUp: false },
    });
    const email = `${randomUUID()}@example.com`;
    const password = "fixture-only-account-game-password";
    const response = await fixture.api.signUpEmail({
      body: { name: "", email, password },
      asResponse: true,
    });
    const result = z.object({ user: z.object({ id: z.uuid() }) }).parse(await response.json());
    this.userIds.push(result.user.id);
    await api.database.db
      .update(authUsers)
      .set({ emailVerified: true })
      .where(eq(authUsers.id, result.user.id));
    const cookieOf = (value: Response) =>
      value.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
    const cookie = cookieOf(response);
    const principal = await createAccountAuth(api.database, authEnvironment).resolve(
      new Headers({ cookie }),
    );
    if (!principal) throw new Error("Account fixture did not authenticate");
    return {
      cookie,
      principal,
      async anotherSession() {
        const signedIn = await fixture.api.signInEmail({
          body: { email, password },
          asResponse: true,
        });
        const nextCookie = cookieOf(signedIn);
        const nextPrincipal = await createAccountAuth(api.database, authEnvironment).resolve(
          new Headers({ cookie: nextCookie }),
        );
        if (!nextPrincipal) throw new Error("Second session did not authenticate");
        return { cookie: nextCookie, principal: nextPrincipal };
      },
    };
  }

  async createGame(api: TestApi, cookie: string, configuration: object = aiMatch) {
    const response = await this.post(api, cookie, "/games", configuration);
    expect(response.statusCode, response.body).toBe(201);
    return gameDetailsSchema.parse(response.json());
  }

  async post(api: TestApi, cookie: string, url: string, payload: object) {
    const response = await api.app.inject({
      method: "POST",
      url,
      payload,
      remoteAddress: this.ip,
      headers: { origin: WEB_ORIGIN, cookie },
    });
    return response;
  }

  override async dispose() {
    await super.dispose();
    const database = integrationDatabase();
    try {
      await database.db.delete(authRateLimits).where(like(authRateLimits.key, `${this.ip}|%`));
      if (this.userIds.length) {
        await database.db.delete(games).where(inArray(games.ownerUserId, this.userIds));
        await database.db.delete(authUsers).where(inArray(authUsers.id, this.userIds.splice(0)));
      }
    } finally {
      await database.close();
    }
  }
}
