import { randomUUID } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import { gameDetailsSchema } from "@neurochess/contracts";
import { authSchema, games } from "@neurochess/database";
import type { Page } from "@playwright/test";
import { eq } from "drizzle-orm";

import { AUTH_ENVIRONMENT, fixtureAuth, registerFixture } from "../../apps/api/test/auth-helpers";
import { integrationDatabase } from "../database";

import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, test } from "./fixtures";
import { expectUnbrokenWords, setPseudoLocalization } from "./text-layout";

test.use({ allowIdentityLoss: true });
const headers = { origin: WEB_ORIGIN, "x-neurochess-identity": "account" };
const endpoint = API_ORIGIN + "/api/auth/delete-account";
async function fixture(page: Page) {
  const database = integrationDatabase();
  const account = await registerFixture(
    fixtureAuth(database, {
      ...AUTH_ENVIRONMENT,
      WEB_ORIGIN,
      BETTER_AUTH_URL: API_ORIGIN,
    }),
  );
  const username = "Delete_" + randomUUID().replaceAll("-", "").slice(0, 16);
  await database.db
    .update(authSchema.user)
    .set({ emailVerified: true })
    .where(eq(authSchema.user.id, account.userId));
  expect(
    (
      await page.request.post(API_ORIGIN + "/api/auth/sign-in/email", {
        headers,
        data: { email: account.email, password: account.password },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post(API_ORIGIN + "/api/profile/onboarding", {
        headers,
        data: { username },
      })
    ).ok(),
  ).toBe(true);
  return {
    ...account,
    database,
    username,
    async close() {
      await database.db.delete(games).where(eq(games.ownerUserId, account.userId));
      await database.db.delete(authSchema.user).where(eq(authSchema.user.id, account.userId));
      await database.close();
    },
  };
}
async function confirm(page: Page) {
  await page.getByRole("button", { name: "Delete account", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete your account?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  return dialog;
}

test("account deletion confirms its full scope, clears other tabs and rejects old games and credentials", async ({
  page,
  context,
}, testInfo) => {
  const data = await fixture(page);
  const playing = await context.newPage();
  try {
    const response = await page.request.post(API_ORIGIN + "/games", {
      headers,
      data: {
        mode: "ai_vs_human",
        seats: {
          white: { type: "human" },
          black: { type: "ai", provider: "openai", modelId: "fixture/model-a", parameters: {} },
        },
      },
    });
    expect(response.status()).toBe(201);
    const { snapshot } = gameDetailsSchema.parse(await response.json());
    expect(
      (
        await page.request.post(API_ORIGIN + "/api/credentials", {
          headers,
          data: {
            save: true,
            provider: "openai",
            label: "Private deletion fixture",
            apiKey: "deletion-browser-key-canary",
          },
        })
      ).status(),
    ).toBe(201);
    await playing.goto(WEB_ORIGIN + `/?game=${snapshot.gameId}`);
    await playing
      .getByLabel("Black · OpenAI · API key", { exact: true })
      .fill("page-owned-delete-canary");
    await page.goto("/account");
    const trigger = page.getByRole("button", { name: "Delete account", exact: true });
    let dialog = await confirm(page);
    await expect(dialog).toContainText("including active and paused games");
    await expect(dialog).toContainText("external backups");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    dialog = await confirm(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Delete account" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await setPseudoLocalization(page, true);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await expectUnbrokenWords(page.locator("dialog button"));
    }
    await setPseudoLocalization(page, false);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
    await page.setViewportSize(testInfo.project.use.viewport!);
    await dialog.screenshot({ path: testInfo.outputPath("account-deletion-confirmation.png") });
    let submissions = 0;
    page.on("request", (request) => {
      if (request.url() === endpoint) submissions++;
    });
    await dialog.getByRole("button", { name: "Delete account" }).click();
    await expect(page.getByText(/Your account and associated data were deleted/)).toBeVisible();
    await expect(playing.getByRole("grid")).toHaveCount(0);
    await expect(playing.getByText(/You are signed out or your session has ended/)).toBeVisible();
    expect(submissions).toBe(1);
    for (const suffix of ["/details", "/replay", "/pgn", "/invocations"]) {
      expect(
        (
          await page.request.get(`${API_ORIGIN}/games/${snapshot.gameId}${suffix}`, { headers })
        ).status(),
      ).toBe(401);
    }
    expect((await page.request.get(API_ORIGIN + "/api/credentials", { headers })).status()).toBe(
      401,
    );
    await page.goto(`/?game=${snapshot.gameId}`);
    await expect(page.getByRole("grid")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Download PGN" })).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        /delete-canary|browser-key-canary|Private deletion/.test(
          document.body.innerText +
            JSON.stringify(localStorage) +
            JSON.stringify(sessionStorage) +
            JSON.stringify(history.state),
        ),
      ),
    ).toBe(false);
  } finally {
    await playing.close();
    await data.close();
  }
});

test("uncertain account deletion never claims success and requires a session check before reconfirming", async ({
  page,
}) => {
  const data = await fixture(page);
  try {
    let attempts = 0;
    await page.route(endpoint, async (route) => {
      if (++attempts === 2) expect((await route.fetch()).status()).toBe(200);
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.goto("/account");
    for (const deleted of [false, true]) {
      await (await confirm(page)).getByRole("button", { name: "Delete account" }).click();
      await expect(
        page.getByText(/We could not confirm whether your account was deleted/),
      ).toBeVisible();
      await expect(page.getByText(/Your account and associated data were deleted/)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Delete account" })).toHaveCount(0);
      await page.getByRole("button", { name: "Check session again" }).click();
      if (!deleted) {
        await expect(page.getByRole("button", { name: "Delete account" })).toBeVisible();
      } else {
        await expect(
          page.getByText(/We could not confirm whether your account was deleted/),
        ).toBeVisible();
      }
    }
    expect(attempts).toBe(2);
  } finally {
    await data.close();
  }
});

test("an old confirmation cannot delete a different account after a silent cookie switch", async ({
  page,
}) => {
  const displayed = await fixture(page);
  let replacement: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await page.goto("/account");
    const dialog = await confirm(page);
    // Request-context sign-in replaces the cookie without a storage event in the rendered page.
    replacement = await fixture(page);
    await dialog.getByRole("button", { name: "Delete account" }).click();
    await expect(page.getByRole("alert")).toContainText("Your account changed");
    for (const account of [displayed, replacement]) {
      expect(
        await account.database.db.$count(authSchema.user, eq(authSchema.user.id, account.userId)),
      ).toBe(1);
    }
    await page.getByRole("button", { name: "Check session again" }).click();
    await expect(page.getByLabel("Username", { exact: true })).toHaveValue(replacement.username);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await replacement?.close();
    await displayed.close();
  }
});

test("stale account deletion requires sign-in and a new explicit confirmation", async ({
  page,
}) => {
  const data = await fixture(page);
  try {
    await data.database.db
      .update(authSchema.session)
      .set({ createdAt: new Date(Date.now() - 3_601_000) })
      .where(eq(authSchema.session.userId, data.userId));
    await page.goto("/account");
    await (await confirm(page)).getByRole("button", { name: "Delete account" }).click();
    await expect(page.getByRole("alert")).toContainText("Sign in again");
    expect(
      await data.database.db.$count(authSchema.user, eq(authSchema.user.id, data.userId)),
    ).toBe(1);
    await page.goto("/auth/sign-in");
    await page.getByLabel("Email", { exact: true }).fill(data.email);
    await page.getByLabel("Password", { exact: true }).fill(data.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("link", { name: data.username, exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await (await confirm(page)).getByRole("button", { name: "Delete account" }).click();
    await expect(page.getByText(/Your account and associated data were deleted/)).toBeVisible();
  } finally {
    await data.close();
  }
});
