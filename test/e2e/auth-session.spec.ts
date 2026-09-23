import { authSessionResponseSchema } from "@neurochess/contracts";
import { authSchema } from "@neurochess/database";
import { eq } from "drizzle-orm";

import { AUTH_COOKIE_NAME } from "../../apps/api/src/auth/service";
import { AUTH_ENVIRONMENT, fixtureAuth, registerFixture } from "../../apps/api/test/auth-helpers";
import { integrationDatabase } from "../database";

import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, startSandbox, test } from "./fixtures";

test("secure account cookies refresh and sign out without affecting the guest game", async ({
  page,
  context,
  isMobile,
}) => {
  const database = integrationDatabase();
  let userId: string | undefined;
  try {
    const auth = fixtureAuth(database, {
      ...AUTH_ENVIRONMENT,
      WEB_ORIGIN,
      BETTER_AUTH_URL: API_ORIGIN,
    });
    const account = await registerFixture(auth);
    userId = account.userId;
    const sandbox = await startSandbox(page, isMobile);
    const tokenValue = account.cookie.slice(account.cookie.indexOf("=") + 1);
    await context.addCookies([
      {
        name: AUTH_COOKIE_NAME,
        value: tokenValue,
        url: "https://localhost",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    await database.db
      .update(authSchema.session)
      .set({
        updatedAt: new Date(Date.now() - 2 * 86_400_000),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .where(eq(authSchema.session.userId, userId));
    const read = await page.evaluate(async (origin) => {
      const response = await fetch(`${origin}/api/auth/get-session`, { credentials: "include" });
      return { status: response.status, body: (await response.json()) as unknown };
    }, API_ORIGIN);
    expect(read.status).toBe(200);
    expect(authSessionResponseSchema.parse(read.body).session?.user.id).toBe(userId);
    const cookie = (await context.cookies(API_ORIGIN)).find(
      (value) => value.name === AUTH_COOKIE_NAME,
    );
    // Only boolean assertions may reach Playwright output; cookies are bearer credentials.
    expect(Boolean(cookie?.httpOnly && cookie.secure && cookie.sameSite === "Lax")).toBe(true);
    expect((cookie?.expires ?? 0) > Date.now() / 1000 + 6 * 86_400).toBe(true);
    expect(await page.evaluate(() => document.cookie.includes("session_token"))).toBe(false);
    expect(JSON.stringify(read.body).includes(account.token)).toBe(false);
    await page.reload();
    const signOut = await page.evaluate(async (origin) => {
      const response = await fetch(`${origin}/api/auth/sign-out`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return { status: response.status, body: (await response.json()) as unknown };
    }, API_ORIGIN);
    expect(signOut).toEqual({ status: 200, body: { success: true } });
    expect(
      (await context.cookies(API_ORIGIN)).some((cookie) => cookie.name === AUTH_COOKIE_NAME),
    ).toBe(false);
    expect(
      await database.db.$count(authSchema.session, eq(authSchema.session.userId, userId)),
    ).toBe(0);
    const guestRead = await page.evaluate(
      async ({ origin, gameId }) => {
        const response = await fetch(`${origin}/games/${gameId}`, { credentials: "include" });
        return response.status;
      },
      { origin: API_ORIGIN, gameId: sandbox.gameId },
    );
    expect(guestRead).toBe(200);
  } finally {
    if (userId) await database.db.delete(authSchema.user).where(eq(authSchema.user.id, userId));
    await database.close();
  }
});
