import { randomUUID } from "node:crypto";
import { text as streamText } from "node:stream/consumers";

import AxeBuilder from "@axe-core/playwright";
import {
  gameDetailsSchema,
  gamePgnResponseSchema,
  gameSnapshotSchema,
} from "@neurochess/contracts";
import type { Page } from "@playwright/test";

import { createAccount } from "./account-helpers";
import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, test } from "./fixtures";
import { setPseudoLocalization } from "./text-layout";

const headers = { origin: WEB_ORIGIN };
const configuration = {
  mode: "ai_vs_ai",
  seats: {
    white: { type: "ai", provider: "openai", modelId: "fixture/model-a", parameters: {} },
    black: { type: "ai", provider: "anthropic", modelId: "fixture/model-a", parameters: {} },
  },
};
async function create(page: Page) {
  const response = await page.request.post(API_ORIGIN + "/games", { headers, data: configuration });
  expect(response.status()).toBe(201);
  return gameDetailsSchema.parse(await response.json()).snapshot;
}
async function stop(page: Page) {
  const snapshot = await create(page);
  const response = await page.request.post(`${API_ORIGIN}/games/${snapshot.gameId}/lifecycle`, {
    headers,
    data: {
      gameId: snapshot.gameId,
      expectedVersion: snapshot.version,
      commandId: randomUUID(),
      action: "abort",
    },
  });
  expect(response.ok()).toBe(true);
  return gameSnapshotSchema.parse(await response.json());
}

test("history reopens canonical results on another session without controllers, keys or provider work", async ({
  page,
  newContext,
}, testInfo) => {
  const account = await createAccount(page.request);
  let completed = await create(page);
  const gameId = completed.gameId;
  expect(
    (
      await page.request.post(`${API_ORIGIN}/games/${gameId}/controller`, {
        headers,
        data: {
          gameId,
          controllerId: gameId,
          expectedVersion: completed.version,
          action: "acquire",
        },
      })
    ).ok(),
  ).toBe(true);
  for (let ply = 0; ply < 4; ply++) {
    const response = await page.request.post(`${API_ORIGIN}/games/${gameId}/ai-turn`, {
      headers,
      data: {
        gameId,
        controllerId: gameId,
        expectedVersion: completed.version,
        commandId: randomUUID(),
        apiKey: "telemetry-fixture",
      },
    });
    expect(response.ok()).toBe(true);
    completed = gameSnapshotSchema.parse(await response.json());
  }
  expect(completed).toMatchObject({
    state: "completed",
    result: "0-1",
    terminationReason: "checkmate",
  });
  const stopped = await stop(page);
  const unfinished = await create(page);
  const pause = await page.request.post(`${API_ORIGIN}/games/${unfinished.gameId}/lifecycle`, {
    headers,
    data: {
      gameId: unfinished.gameId,
      expectedVersion: unfinished.version,
      commandId: randomUUID(),
      action: "pause",
    },
  });
  const paused = gameSnapshotSchema.parse(await pause.json());
  await page.goto("/history");
  const list = page.getByRole("list", { name: "Finished games" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByText("Aborted", { exact: true })).toBeVisible();
  await expect(list.getByText("Completed", { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("private-history.png"), fullPage: true });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("link", { name: /Open replay/ })).toHaveCount(0);

  const device = await newContext({
    viewport: page.viewportSize(),
    isMobile: testInfo.project.name === "mobile-touch",
    hasTouch: testInfo.project.name === "mobile-touch",
  });
  try {
    const review = await device.newPage();
    expect(
      (
        await review.request.post(API_ORIGIN + "/api/auth/sign-in/email", {
          headers,
          data: { email: account.email, password: account.password },
        })
      ).ok(),
    ).toBe(true);
    const writes: string[] = [];
    review.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.origin === API_ORIGIN &&
        (request.method() !== "GET" ||
          url.pathname.startsWith("/credentials") ||
          url.pathname.startsWith("/providers"))
      ) {
        writes.push(url.pathname);
      }
    });
    await review.goto(WEB_ORIGIN + "/history");
    await expect(
      review.getByRole("list", { name: "Finished games" }).getByRole("listitem"),
    ).toHaveCount(2);
    const replay = review.locator(`a[href="/?game=${gameId}"]`);
    await replay.focus();
    await replay.press("Enter");
    await expect(review.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
    await expect(review.getByRole("grid")).toHaveAttribute("data-fen", completed.fen);
    await review.getByRole("button", { name: "First", exact: true }).click();
    await review.getByRole("button", { name: "Next", exact: true }).click();
    await expect(
      review.getByText('<img src=x onerror="alert(1)"> **Viewer note**', { exact: true }),
    ).toBeVisible();
    await expect(review.locator('img[src="x"]')).toHaveCount(0);
    await expect(review.getByRole("grid")).toHaveAttribute("data-fen", completed.moves[0]!.fen);
    const canonical = gamePgnResponseSchema.parse(
      await (await review.request.get(`${API_ORIGIN}/games/${gameId}/pgn`)).json(),
    );
    expect(canonical.pgn).toBe(completed.pgn);
    const downloading = review.waitForEvent("download");
    await review.getByRole("button", { name: "Download PGN", exact: true }).click();
    const stream = await (await downloading).createReadStream();
    expect(stream).not.toBeNull();
    expect(await streamText(stream)).toBe(canonical.pgn);
    await review.getByRole("link", { name: "History", exact: true }).click();
    await review.locator(`a[href="/?game=${stopped.gameId}"]`).click();
    await expect(review.getByRole("heading", { name: "Game stopped", exact: true })).toBeVisible();
    await expect(review.getByLabel(/API key/)).toHaveCount(0);
    expect(writes).toEqual([]);
    expect(
      gameSnapshotSchema.parse(
        await (await review.request.get(`${API_ORIGIN}/games/${unfinished.gameId}`)).json(),
      ),
    ).toEqual(paused);
  } finally {
    await device.close();
  }
});

test("history pages remain bounded, recover from load errors, and fit mobile and expanded text", async ({
  page,
}, testInfo) => {
  await createAccount(page.request);
  const ids: string[] = [];
  for (let index = 0; index < 21; index++) ids.push((await stop(page)).gameId);
  let fail = true;
  await page.route("**/games/history?*", async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({ status: 200, json: {} });
    } else await route.continue();
  });
  await page.goto("/history");
  await expect(page.getByRole("alert")).toContainText("Game history could not be loaded");
  await page.getByRole("button", { name: "Retry history" }).click();
  const rows = page.getByRole("list", { name: "Finished games" }).getByRole("listitem");
  await expect(rows).toHaveCount(20);
  const newer = page.getByRole("button", { name: "Newer games" });
  const older = page.getByRole("button", { name: "Older games" });
  await older.focus();
  await older.press("Enter");
  await expect(rows).toHaveCount(1);
  await expect(older).toBeFocused();
  await expect(rows.getByRole("link", { name: /Open replay/ })).toHaveAttribute(
    "href",
    "/?game=" + ids[0]!,
  );
  await newer.click();
  await expect(rows).toHaveCount(20);
  for (const width of testInfo.project.name === "desktop" ? [1024, 1440] : [320, 390, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const enlarged of [false, true]) {
      await setPseudoLocalization(page, enlarged);
      await page.evaluate((large) => {
        document.documentElement.style.fontSize = large ? "200%" : "100%";
      }, enlarged);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
  await setPseudoLocalization(page, false);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "100%";
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const clearing = page.getByRole("button", { name: "Clear history", exact: true });
  await clearing.click();
  const confirmation = page.getByRole("dialog", { name: "Clear all finished games?" });
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(confirmation).toContainText("every page");
  await page.keyboard.press("Escape");
  await expect(clearing).toBeFocused();
  await clearing.click();
  for (const width of testInfo.project.name === "desktop" ? [1024, 1440] : [320, 390, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    await setPseudoLocalization(page, true);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    expect(
      await confirmation.evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.keyboard.press("Tab");
    await confirmation.getByRole("button", { name: /Cancel/ }).focus();
    await expect(confirmation.getByRole("button", { name: /Cancel/ })).toBeInViewport();
  }
  await setPseudoLocalization(page, false);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "100%";
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("clear-history-confirmation.png"),
    fullPage: true,
  });
  let failClear = true;
  await page.route("**/games/history/clear", async (route) => {
    if (failClear) {
      failClear = false;
      await route.fulfill({ status: 200, json: {} });
    } else await route.continue();
  });
  await confirmation.getByRole("button", { name: "Clear history", exact: true }).click();
  await expect(confirmation.getByRole("alert")).toContainText("Deletion could not be confirmed");
  expect((await page.request.get(`${API_ORIGIN}/games/${ids[0]!}/pgn`)).status()).toBe(200);
  await confirmation.getByRole("button", { name: "Clear history", exact: true }).click();
  await expect(page.getByText("Finished game history cleared.")).toBeVisible();
  await expect(rows).toHaveCount(0);
  await expect(page.getByText(/No completed or aborted games yet/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Finished games" })).toBeFocused();
  await expect(page.getByText("Page 1", { exact: true })).toBeVisible();
  for (const id of ids) {
    expect((await page.request.get(`${API_ORIGIN}/games/${id}/pgn`)).status()).toBe(404);
  }
});

test("guest guidance and account privacy survive a switch to another account", async ({ page }) => {
  await page.goto("/history");
  await expect(page.getByText(/Guest games stay separate/)).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/auth/sign-in?returnTo=%2Fhistory",
  );
  await createAccount(page.request);
  const original = await stop(page);
  await page.goto("/history");
  await expect(page.locator(`a[href="/?game=${original.gameId}"]`)).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("link", { name: /Open replay/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  expect((await page.request.get(`${API_ORIGIN}/games/${original.gameId}/pgn`)).status()).toBe(401);
  await createAccount(page.request);
  await page.goto("/history");
  await expect(page.getByText(/No completed or aborted games yet/)).toBeVisible();
  expect((await page.request.get(`${API_ORIGIN}/games/${original.gameId}/replay`)).status()).toBe(
    404,
  );
});

test("individual deletion retries an uncertain acknowledgement and removes private URL access while preserving unfinished play and keys", async ({
  page,
  expectedGame404s,
}, testInfo) => {
  const account = await createAccount(page.request);
  const deleted = await stop(page);
  const retained = await stop(page);
  const active = await create(page);
  const pause = await page.request.post(`${API_ORIGIN}/games/${active.gameId}/lifecycle`, {
    headers,
    data: {
      gameId: active.gameId,
      expectedVersion: active.version,
      commandId: randomUUID(),
      action: "pause",
    },
  });
  expect(pause.ok()).toBe(true);
  const paused = gameSnapshotSchema.parse(await pause.json());
  const saved = await page.request.post(API_ORIGIN + "/credentials", {
    headers,
    data: {
      credentialId: randomUUID(),
      provider: "openai",
      label: "Keep this key",
      apiKey: "history-fixture-key",
      save: true,
    },
  });
  expect(saved.status()).toBe(201);
  const keysBefore: unknown = await (await page.request.get(API_ORIGIN + "/credentials")).json();
  await page.goto("/history");
  const row = page
    .getByRole("listitem")
    .filter({ has: page.locator(`a[href="/?game=${deleted.gameId}"]`) });
  const trigger = row.getByRole("button", { name: /Delete game/ });
  await expect(trigger).toHaveAccessibleName(new RegExp(deleted.gameId));
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Delete this game?" });
  await expect(dialog).toContainText(deleted.gameId);
  await expect(dialog).toContainText("fixture/model-a");
  await expect(dialog).not.toContainText(retained.gameId);
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Delete game", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("delete-game-confirmation.png"),
    fullPage: true,
  });
  await cancel.click();
  await expect(trigger).toBeFocused();
  expect((await page.request.get(`${API_ORIGIN}/games/${deleted.gameId}/pgn`)).status()).toBe(200);
  let writes = 0;
  await page.route(`**/games/${deleted.gameId}/delete`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ gameId: deleted.gameId, confirm: true });
    writes++;
    if (writes === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.fulfill({ status: 200, json: {} });
    } else await route.continue();
  });
  await trigger.click();
  await dialog.getByRole("button", { name: "Delete game", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Deletion could not be confirmed");
  expect((await page.request.get(`${API_ORIGIN}/games/${deleted.gameId}/pgn`)).status()).toBe(404);
  await dialog.getByRole("button", { name: "Delete game", exact: true }).click();
  await expect(page.getByText("Game deleted.")).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(
    page.getByRole("list", { name: "Finished games" }).getByRole("listitem"),
  ).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Finished games" })).toBeFocused();
  await expect(page.getByRole("heading", { name: "Finished games" })).toHaveAccessibleDescription(
    "Game deleted.",
  );
  expect(writes).toBe(2);
  for (const suffix of ["", "/details", "/replay", "/pgn", "/invocations"]) {
    expect(
      (await page.request.get(`${API_ORIGIN}/games/${deleted.gameId}${suffix}`)).status(),
    ).toBe(404);
  }
  expectedGame404s.set(page, new Set([`${API_ORIGIN}/games/${deleted.gameId}/details`]));
  await page.goto(`/?game=${deleted.gameId}`);
  await expect(
    page.locator("p").filter({
      hasText: "This private game is unavailable to your session. Keys have been cleared.",
    }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Download PGN" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Next", exact: true })).toHaveCount(0);
  await page.goto("/history");
  await expect(page.locator(`a[href="/?game=${retained.gameId}"]`)).toBeVisible();
  await page.getByRole("button", { name: "Clear history", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Clear history", exact: true })
    .click();
  await expect(page.getByText(/No completed or aborted games yet/)).toBeVisible();
  expect(await (await page.request.get(API_ORIGIN + "/credentials")).json()).toEqual(keysBefore);
  expect(await (await page.request.get(API_ORIGIN + "/profile")).json()).toMatchObject({
    username: account.username,
  });
  expect(
    gameSnapshotSchema.parse(
      await (await page.request.get(`${API_ORIGIN}/games/${active.gameId}`)).json(),
    ),
  ).toEqual(paused);
});
