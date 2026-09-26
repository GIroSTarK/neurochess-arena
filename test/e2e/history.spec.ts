import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import {
  type AiGameConfiguration,
  gameDetailsSchema,
  gameSnapshotSchema,
} from "@neurochess/contracts";
import { authSchema, games } from "@neurochess/database";
import type { Page } from "@playwright/test";
import { inArray } from "drizzle-orm";

import { AUTH_ENVIRONMENT, fixtureAuth, registerFixture } from "../../apps/api/test/auth-helpers";
import { integrationDatabase } from "../database";

import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, test } from "./fixtures";
import { expectUnbrokenWords, setPseudoLocalization } from "./text-layout";

test.use({ allowIdentityLoss: true });
const headers = { origin: WEB_ORIGIN };
const configuration: AiGameConfiguration = {
  mode: "ai_vs_ai",
  seats: {
    white: { type: "ai", provider: "openai", modelId: "fixture/model-a", parameters: {} },
    black: { type: "ai", provider: "anthropic", modelId: "fixture/model-a", parameters: {} },
  },
};
async function fixture() {
  const database = integrationDatabase();
  const auth = fixtureAuth(database, {
    ...AUTH_ENVIRONMENT,
    WEB_ORIGIN,
    BETTER_AUTH_URL: API_ORIGIN,
  });
  const accounts = [await registerFixture(auth), await registerFixture(auth)];
  const ids = accounts.map((account) => account.userId);
  await database.db
    .update(authSchema.user)
    .set({ emailVerified: true })
    .where(inArray(authSchema.user.id, ids));
  return {
    accounts,
    async close() {
      await database.db.delete(games).where(inArray(games.ownerUserId, ids));
      await database.db.delete(authSchema.user).where(inArray(authSchema.user.id, ids));
      await database.close();
    },
  };
}
async function login(page: Page, account: { email: string; password: string }, onboard = true) {
  expect(
    (
      await page.request.post(API_ORIGIN + "/api/auth/sign-in/email", {
        headers,
        data: { email: account.email, password: account.password },
      })
    ).ok(),
  ).toBe(true);
  if (onboard) {
    expect(
      (
        await page.request.post(API_ORIGIN + "/api/profile/onboarding", {
          headers,
          data: { username: "History_" + randomUUID().replaceAll("-", "").slice(0, 16) },
        })
      ).ok(),
    ).toBe(true);
  }
}
async function create(page: Page, config = configuration) {
  const response = await page.request.post(API_ORIGIN + "/games", { headers, data: config });
  expect(response.status()).toBe(201);
  return gameDetailsSchema.parse(await response.json()).snapshot;
}
async function abort(page: Page) {
  const game = await create(page);
  const response = await page.request.post(`${API_ORIGIN}/games/${game.gameId}/lifecycle`, {
    headers,
    data: {
      gameId: game.gameId,
      expectedVersion: game.version,
      commandId: randomUUID(),
      action: "abort",
    },
  });
  expect(response.ok()).toBe(true);
  return gameSnapshotSchema.parse(await response.json());
}

test.describe("history deletion", () => {
  test.use({ allowMissingGames: true });

  test("confirms individual and all-page deletion, resets pagination and rejects deleted URLs", async ({
    page,
  }, testInfo) => {
    const data = await fixture();
    try {
      await login(page, data.accounts[0]!);
      const oldest = await abort(page);
      const others = [];
      for (let i = 0; i < 20; i++) others.push(await abort(page));
      const active = await create(page);
      const paused = gameSnapshotSchema.parse(
        await (
          await page.request.post(`${API_ORIGIN}/games/${active.gameId}/lifecycle`, {
            headers,
            data: {
              gameId: active.gameId,
              expectedVersion: active.version,
              commandId: randomUUID(),
              action: "pause",
            },
          })
        ).json(),
      );
      await page.goto("/history");
      await page.getByRole("button", { name: "Older games" }).click();
      const trigger = page.getByRole("button", { name: "Delete game", exact: true });
      await expect(trigger).toHaveCount(1);
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Delete this game?" });
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await expect(page.locator(`a[href="/?game=${oldest.gameId}"]`)).toBeVisible();
      await trigger.click();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: "Delete game" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
      await dialog.getByRole("button", { name: "Delete game" }).click();
      await expect(page.getByText("Game deleted.", { exact: true })).toBeFocused();
      await expect(page.getByRole("link", { name: "Replay game", exact: true })).toHaveCount(20);
      await expect(page.getByRole("button", { name: "Newer games" })).toBeDisabled();
      await page.getByRole("button", { name: "Clear history", exact: true }).click();
      const clear = page.getByRole("dialog", { name: "Clear all game history?" });
      await expect(clear.getByRole("button", { name: "Cancel" })).toBeFocused();
      await expect(clear).toContainText("across every history page");
      await setPseudoLocalization(page, true);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "200%";
      });
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await expectUnbrokenWords(page.locator("dialog button"));
      }
      await setPseudoLocalization(page, false);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = "";
      });
      await page.setViewportSize({
        width: testInfo.project.name === "desktop" ? 1440 : 390,
        height: 1000,
      });
      await clear.screenshot({ path: testInfo.outputPath("clear-history-confirmation.png") });
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await clear.getByRole("button", { name: "Clear history", exact: true }).click();
      await expect(page.getByText("You have no completed or aborted games yet.")).toBeVisible();
      await expect(page.getByText(/History cleared/)).toBeFocused();
      expect(await (await page.request.get(`${API_ORIGIN}/games/${paused.gameId}`)).json()).toEqual(
        paused,
      );
      for (const id of [oldest.gameId, others[0]!.gameId]) {
        for (const suffix of ["", "/details", "/replay", "/pgn", "/invocations"]) {
          expect((await page.request.get(`${API_ORIGIN}/games/${id}${suffix}`)).status()).toBe(404);
        }
        await page.goto(`/?game=${id}`);
        await expect(
          page
            .locator("#arena-match")
            .getByText("This private game is unavailable to your session. Keys have been cleared."),
        ).toBeVisible();
        await expect(page.getByRole("button", { name: "Download PGN", exact: true })).toHaveCount(
          0,
        );
        await expect(page.getByRole("button", { name: "Next", exact: true })).toHaveCount(0);
      }
    } finally {
      await data.close();
    }
  });

  for (const operation of ["game", "all"] as const) {
    test(`keeps accurate history after failed ${operation} deletion and a lost acknowledgement`, async ({
      page,
    }) => {
      const data = await fixture();
      try {
        await login(page, data.accounts[0]!);
        const target = await abort(page);
        const path =
          operation === "game" ? `/games/${target.gameId}/delete` : "/games/history/clear";
        const label = operation === "game" ? "Delete game" : "Clear history";
        let attempts = 0;
        await page.route(API_ORIGIN + path, async (route) => {
          if (++attempts === 2) expect((await route.fetch()).status()).toBe(200);
          await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        });
        await page.goto("/history");
        for (const actualDeletion of [false, true]) {
          await page.getByRole("button", { name: label, exact: true }).click();
          const dialog = page.getByRole("dialog");
          await dialog.getByRole("button", { name: label, exact: true }).click();
          await expect(dialog.getByRole("alert")).toContainText("We could not confirm deletion.");
          await dialog.getByRole("button", { name: "Cancel" }).click();
          await expect(page.getByRole("link", { name: "Replay game", exact: true })).toHaveCount(1);
          await page.getByRole("button", { name: "Refresh history" }).click();
          if (actualDeletion) {
            await expect(
              page.getByText("You have no completed or aborted games yet."),
            ).toBeVisible();
          } else {
            await expect(page.getByRole("link", { name: "Replay game", exact: true })).toHaveCount(
              1,
            );
          }
        }
        expect(attempts).toBe(2);
      } finally {
        await data.close();
      }
    });
  }
});

test("history paginates privately across sessions and reopens canonical replay, commentary and PGN without control", async ({
  page,
  browser,
}, testInfo) => {
  const data = await fixture();
  const otherContext = await browser.newContext();
  const second = await otherContext.newPage();
  try {
    await login(page, data.accounts[0]!);
    for (let index = 0; index < 20; index++) await abort(page);
    let completed = await create(page);
    const controllerId = randomUUID();
    expect(
      (
        await page.request.post(`${API_ORIGIN}/games/${completed.gameId}/controller`, {
          headers,
          data: {
            gameId: completed.gameId,
            controllerId,
            expectedVersion: completed.version,
            action: "acquire",
          },
        })
      ).ok(),
    ).toBe(true);
    for (let ply = 0; ply < 4; ply++) {
      const response = await page.request.post(`${API_ORIGIN}/games/${completed.gameId}/ai-turn`, {
        headers,
        data: {
          gameId: completed.gameId,
          controllerId,
          expectedVersion: completed.version,
          commandId: randomUUID(),
          apiKey: "telemetry-fixture",
        },
      });
      expect(response.ok()).toBe(true);
      completed = gameSnapshotSchema.parse(await response.json());
    }
    expect(completed.state).toBe("completed");
    const stopped = await abort(page);
    const unfinished = await create(page);
    const pausedResponse = await page.request.post(
      `${API_ORIGIN}/games/${unfinished.gameId}/lifecycle`,
      {
        headers,
        data: {
          gameId: unfinished.gameId,
          expectedVersion: unfinished.version,
          commandId: randomUUID(),
          action: "pause",
        },
      },
    );
    const paused = gameSnapshotSchema.parse(await pausedResponse.json());
    const writes: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /^\/(games|providers|guest-session)/.test(new URL(request.url()).pathname)
      ) {
        writes.push(new URL(request.url()).pathname);
      }
    });
    await page.goto("/history");
    await expect(page.getByRole("link", { name: "Replay game", exact: true })).toHaveCount(20);
    await expect(page.getByText("Completed", { exact: true })).toBeVisible();
    await expect(page.locator(`a[href="/?game=${stopped.gameId}"]`)).toBeVisible();
    await page.getByRole("button", { name: "Older games" }).click();
    await expect(page.getByRole("link", { name: "Replay game", exact: true })).toHaveCount(2);
    await page.getByRole("button", { name: "Newer games" }).click();
    await expect(page.getByRole("link", { name: "Replay game", exact: true })).toHaveCount(20);
    await page.screenshot({ path: testInfo.outputPath("history.png"), fullPage: true });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.locator(`a[href="/?game=${completed.gameId}"]`).click();
    await expect(page.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
    await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "First", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    const commentary = page.getByRole("region", { name: "Commentary & move details" });
    await expect(
      commentary.getByText('<img src=x onerror="alert(1)"> **Viewer note**', { exact: true }),
    ).toBeVisible();
    await expect(commentary.locator("img, script, strong")).toHaveCount(0);
    await page.getByRole("tab", { name: "Analysis", exact: true }).click();
    await expect(page.getByText("Recorded attempts: 6", { exact: true })).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download PGN", exact: true }).click();
    const path = testInfo.outputPath("canonical.pgn");
    await (await download).saveAs(path);
    expect(await readFile(path, "utf8")).toBe(completed.pgn);
    expect(writes).toEqual([]);
    expect(await (await page.request.get(`${API_ORIGIN}/games/${paused.gameId}`)).json()).toEqual(
      paused,
    );
    await login(second, data.accounts[0]!, false);
    await second.goto(WEB_ORIGIN + "/history");
    await expect(second.locator(`a[href="/?game=${completed.gameId}"]`)).toBeVisible();
    await second.locator(`a[href="/?game=${stopped.gameId}"]`).click();
    await expect(second.getByRole("heading", { name: "Game stopped", exact: true })).toBeVisible();
    await login(second, data.accounts[1]!);
    await second.goto(WEB_ORIGIN + "/history");
    await expect(second.getByText("You have no completed or aborted games yet.")).toBeVisible();
    for (const suffix of ["/details", "/replay", "/pgn", "/invocations"]) {
      expect(
        (await second.request.get(`${API_ORIGIN}/games/${completed.gameId}${suffix}`)).status(),
      ).toBe(404);
    }
    await otherContext.clearCookies();
    expect((await second.request.get(API_ORIGIN + "/games/history")).status()).toBe(401);
    for (const suffix of ["/replay", "/pgn"]) {
      expect(
        (await second.request.get(`${API_ORIGIN}/games/${completed.gameId}${suffix}`)).status(),
      ).toBe(401);
    }
  } finally {
    await otherContext.close();
    await data.close();
  }
});

test("history has guest, empty, retry and accessible responsive states", async ({
  page,
}, testInfo) => {
  const data = await fixture();
  try {
    await page.goto("/history");
    await expect(page.getByText(/Guests have no durable game history/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in to view history" })).toHaveAttribute(
      "href",
      "/auth/sign-in?returnTo=%2Fhistory",
    );
    await login(page, data.accounts[0]!);
    await page.goto("/history");
    await expect(page.getByText("You have no completed or aborted games yet.")).toBeVisible();
    await abort(page);
    await page.route("**/games/history", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );
    await page.reload();
    await expect(page.getByRole("alert")).toHaveText("History could not be loaded. Try again.");
    await page.unroute("**/games/history");
    await page.getByRole("button", { name: "Retry history" }).click();
    await expect(page.getByText("Aborted", { exact: true })).toBeVisible();
    const replay = page.getByRole("link", { name: "Replay game", exact: true });
    await replay.focus();
    await expect(replay).toBeFocused();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await setPseudoLocalization(page, true);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await expectUnbrokenWords(page.locator("#history-main button, #history-main a, nav a"));
    }
    await page.setViewportSize({
      width: testInfo.project.name === "desktop" ? 1440 : 390,
      height: 1000,
    });
    await page.screenshot({ path: testInfo.outputPath("history-expanded.png"), fullPage: true });
  } finally {
    await data.close();
  }
});
