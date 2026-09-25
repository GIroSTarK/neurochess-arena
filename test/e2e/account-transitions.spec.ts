import { randomUUID } from "node:crypto";

import { gameDetailsSchema } from "@neurochess/contracts";
import { authSchema, games } from "@neurochess/database";
import type { Page } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";

import { AUTH_ENVIRONMENT, fixtureAuth, registerFixture } from "../../apps/api/test/auth-helpers";
import { integrationDatabase } from "../database";

import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, test } from "./fixtures";

test.use({ allowIdentityLoss: true });

async function accounts() {
  const database = integrationDatabase();
  const auth = fixtureAuth(database, {
    ...AUTH_ENVIRONMENT,
    WEB_ORIGIN,
    BETTER_AUTH_URL: API_ORIGIN,
  });
  const created = [await registerFixture(auth), await registerFixture(auth)];
  const ids = created.map((account) => account.userId);
  await database.db
    .update(authSchema.user)
    .set({ emailVerified: true })
    .where(inArray(authSchema.user.id, ids));
  return {
    database,
    created,
    async close() {
      await database.db.delete(games).where(inArray(games.ownerUserId, ids));
      await database.db.delete(authSchema.user).where(inArray(authSchema.user.id, ids));
      await database.close();
    },
  };
}
async function login(page: Page, account: { email: string; password: string }) {
  await page.goto("/auth/sign-in");
  await page.getByLabel("Email", { exact: true }).fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choose your arena identity" })).toBeVisible();
}
async function onboard(page: Page) {
  const username = "User_" + randomUUID().replaceAll("-", "").slice(0, 14);
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("heading", { name: "Set up a game" })).toBeVisible();
  return username;
}

test("another tab switching accounts fences delayed discovery; expired sessions never bootstrap guests", async ({
  page,
  context,
}) => {
  const fixture = await accounts();
  const [alice, bob] = fixture.created;
  if (!alice || !bob) throw new Error("Account fixtures missing");
  const release = Promise.withResolvers<void>();
  const received = Promise.withResolvers<void>();
  let bootstraps = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/guest-session")) bootstraps++;
  });
  try {
    await login(page, alice);
    const aliceName = await onboard(page);
    await page.route(
      "**/providers/models",
      async (route) => {
        const response = await route.fetch();
        received.resolve();
        await release.promise;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    const white = page.getByRole("group", { name: "White", exact: true });
    await white.getByLabel("API key", { exact: true }).fill("old-account-key-fixture");
    await white.getByRole("button", { name: "Load models", exact: true }).click();
    await received.promise;
    const other = await context.newPage();
    await login(other, bob);
    await expect(page.getByRole("heading", { name: "Choose your arena identity" })).toBeVisible();
    const bobName = await onboard(page);
    release.resolve();
    await expect(page.getByRole("link", { name: bobName, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: aliceName, exact: true })).toHaveCount(0);
    await expect(white.getByLabel("API key", { exact: true })).toHaveValue("");
    await expect(white.getByRole("combobox", { name: "Model", exact: true })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await other.close();
    await fixture.database.db
      .delete(authSchema.session)
      .where(eq(authSchema.session.userId, bob.userId));
    await white.getByLabel("API key", { exact: true }).fill("expiry-key-fixture");
    await white.getByRole("button", { name: "Load models", exact: true }).click();
    await expect(page.getByText(/You are signed out or your session has ended/)).toBeVisible();
    await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText(/You are signed out or your session has ended/)).toBeVisible();
    expect(bootstraps).toBe(0);
  } finally {
    release.resolve();
    await fixture.close();
  }
});

test("guest games stay separate and require explicit guest return after sign-out", async ({
  page,
  context,
}) => {
  const fixture = await accounts();
  const account = fixture.created[0];
  if (!account) throw new Error("Account fixture missing");
  try {
    await context.request.post(API_ORIGIN + "/guest-session", {
      headers: { origin: WEB_ORIGIN },
      data: {},
    });
    const response = await context.request.post(API_ORIGIN + "/games", {
      headers: { origin: WEB_ORIGIN },
      data: {
        mode: "ai_vs_human",
        seats: {
          white: { type: "human" },
          black: { type: "ai", provider: "openai", modelId: "model-a", parameters: {} },
        },
      },
    });
    const guest = gameDetailsSchema.parse(await response.json());
    await page.goto("/?game=" + guest.snapshot.gameId);
    await expect(page.getByRole("grid")).toBeVisible();
    await login(page, account);
    await onboard(page);
    await expect(page.getByRole("button", { name: "Return to game" })).toHaveCount(0);
    const [stored] = await fixture.database.db
      .select({ account: games.ownerUserId, guest: games.ownerGuestSessionId })
      .from(games)
      .where(eq(games.id, guest.snapshot.gameId));
    expect(stored?.account).toBeNull();
    expect(Boolean(stored?.guest)).toBe(true);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByText(/You are signed out or your session has ended/)).toBeVisible();
    await expect(page.getByRole("grid")).toHaveCount(0);
    await page.getByRole("button", { name: "Continue as guest" }).click();
    await page.getByRole("button", { name: "Return to game" }).click();
    await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
    expect(new URL(page.url()).searchParams.get("game")).toBe(guest.snapshot.gameId);
  } finally {
    await fixture.close();
  }
});
