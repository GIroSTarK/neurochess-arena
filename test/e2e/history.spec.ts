import { randomUUID } from "node:crypto";
import { text as streamText } from "node:stream/consumers";

import AxeBuilder from "@axe-core/playwright";
import {
  credentialListResponseSchema,
  gameDetailsSchema,
  gamePgnResponseSchema,
  type GameSnapshot,
  gameSnapshotSchema,
} from "@neurochess/contracts";
import type { Page } from "@playwright/test";

import { credentialAccount } from "./credential-helpers";
import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, readSnapshot, test } from "./fixtures";
import { setPseudoLocalization } from "./text-layout";

const headers = { origin: WEB_ORIGIN };
const cors = {
  "access-control-allow-origin": WEB_ORIGIN,
  "access-control-allow-credentials": "true",
};
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
async function pause(page: Page, snapshot: GameSnapshot) {
  const response = await page.request.post(`${API_ORIGIN}/games/${snapshot.gameId}/lifecycle`, {
    headers,
    data: {
      gameId: snapshot.gameId,
      expectedVersion: snapshot.version,
      commandId: randomUUID(),
      action: "pause",
    },
  });
  expect(response.ok()).toBe(true);
  return gameSnapshotSchema.parse(await response.json());
}
function deleteButton(page: Page, game: GameSnapshot) {
  return page
    .getByRole("list", { name: "Finished games" })
    .getByRole("listitem")
    .filter({ has: page.locator(`a[href="/?game=${game.gameId}"]`) })
    .getByRole("button", { name: /^Delete game/ });
}

test("history reopens canonical results on another session without controllers, keys or provider work", async ({
  page,
  browser,
}, testInfo) => {
  const account = await credentialAccount(page);
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

  const device = await browser.newContext({
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
  await credentialAccount(page);
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
});

test("guest guidance and account privacy survive a switch to another account", async ({ page }) => {
  await page.goto("/history");
  await expect(page.getByText(/Guest games stay separate/)).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/auth/sign-in?returnTo=%2Fhistory",
  );
  await credentialAccount(page);
  const original = await stop(page);
  await page.goto("/history");
  await expect(page.locator(`a[href="/?game=${original.gameId}"]`)).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("link", { name: /Open replay/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  expect((await page.request.get(`${API_ORIGIN}/games/${original.gameId}/pgn`)).status()).toBe(401);
  await credentialAccount(page);
  await page.goto("/history");
  await expect(page.getByText(/No completed or aborted games yet/)).toBeVisible();
  expect((await page.request.get(`${API_ORIGIN}/games/${original.gameId}/replay`)).status()).toBe(
    404,
  );
});

test("deleting a result confirms first, survives failed or unacknowledged requests, and closes its URLs", async ({
  page,
  browser,
}, testInfo) => {
  const account = await credentialAccount(page);
  const kept = await stop(page);
  const retried = await stop(page);
  const unacknowledged = await stop(page);
  const paused = await pause(page, await create(page));
  await page.goto("/history");
  const rows = page.getByRole("list", { name: "Finished games" }).getByRole("listitem");
  await expect(rows).toHaveCount(3);
  await page.screenshot({ path: testInfo.outputPath("history-deletion.png"), fullPage: true });

  const trigger = deleteButton(page, retried);
  await trigger.focus();
  await trigger.press("Enter");
  let dialog = page.getByRole("dialog", { name: "Delete this game?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(dialog).toContainText(
    "Your other games, unfinished game, saved provider keys and profile are kept.",
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("history-delete-dialog.png") });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  let delivery: "unreached" | "unacknowledged" | "held" = "unreached";
  const held: (() => void)[] = [];
  await page.route(API_ORIGIN + "/games/history/delete", async (route) => {
    if (delivery === "unreached") {
      // The test answers before the API sees the request, with an unusable acknowledgement.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: cors,
        body: "{}",
      });
    } else if (delivery === "unacknowledged") {
      // The API commits the deletion, but its acknowledgement never reaches the page.
      await route.fulfill({ response: await route.fetch(), body: "{}" });
    } else {
      const release = Promise.withResolvers<void>();
      held.push(release.resolve);
      await release.promise;
      await route.continue();
    }
  });
  await trigger.press("Enter");
  dialog = page.getByRole("dialog", { name: "Delete this game?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  // The pending label replaces the accessible name of the same button.
  const confirm = dialog.getByRole("button", { name: /^(Delete|Deleting) game/ });
  await expect(confirm).toBeFocused();
  await expect(confirm).toHaveText("Delete game");
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("alert")).toContainText("Repeating it is safe");
  await expect(rows).toHaveCount(3);

  // While the retry is pending, repeated activation and Escape neither resubmit nor dismiss it.
  delivery = "held";
  await expect(confirm).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(confirm).toHaveAttribute("aria-disabled", "true");
  await expect(confirm).toHaveText("Deleting game…");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect.poll(() => held.length).toBe(1);
  await expect(dialog).toBeVisible();
  held.at(0)?.();
  await expect(page.getByText("Game deleted.", { exact: true })).toBeVisible();
  expect(held).toHaveLength(1);
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Finished games" })).toBeFocused();

  delivery = "unacknowledged";
  await deleteButton(page, unacknowledged).click();
  dialog = page.getByRole("dialog", { name: "Delete this game?" });
  await dialog.getByRole("button", { name: "Delete game", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("could not be confirmed");
  await expect(rows).toHaveCount(2);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.getByRole("link", { name: /Open replay/ })).toHaveAttribute(
    "href",
    "/?game=" + kept.gameId,
  );

  for (const game of [retried, unacknowledged]) {
    for (const suffix of ["", "/details", "/replay", "/pgn", "/invocations"]) {
      const read = await page.request.get(`${API_ORIGIN}/games/${game.gameId}${suffix}`);
      expect(read.status(), suffix).toBe(404);
    }
  }
  expect(await readSnapshot(page, paused.gameId)).toEqual(paused);

  // Another signed-in device cannot reopen, replay or export the deleted private URL.
  const device = await browser.newContext({
    viewport: page.viewportSize(),
    isMobile: testInfo.project.name === "mobile-touch",
    hasTouch: testInfo.project.name === "mobile-touch",
  });
  try {
    await device.addCookies([
      {
        name: "neurochess_test_client",
        value: randomUUID(),
        url: API_ORIGIN,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    const review = await device.newPage();
    expect(
      (
        await review.request.post(API_ORIGIN + "/api/auth/sign-in/email", {
          headers,
          data: { email: account.email, password: account.password },
        })
      ).ok(),
    ).toBe(true);
    await review.goto(`${WEB_ORIGIN}/?game=${retried.gameId}`);
    await expect(
      review.locator("p", { hasText: "This private game is unavailable to your session." }),
    ).toBeVisible();
    await expect(review.getByRole("button", { name: "Download PGN" })).toHaveCount(0);
    await review.goto(WEB_ORIGIN + "/history");
    await expect(
      review.getByRole("list", { name: "Finished games" }).getByRole("listitem"),
    ).toHaveCount(1);
  } finally {
    await device.close();
  }
});

test("clearing history keeps the unfinished game and saved keys, with a dialog that fits narrow and enlarged text", async ({
  page,
}, testInfo) => {
  await credentialAccount(page);
  for (let index = 0; index < 3; index++) await stop(page);
  const paused = await pause(page, await create(page));
  const saved = await page.request.post(API_ORIGIN + "/credentials", {
    headers,
    data: {
      credentialId: randomUUID(),
      save: true,
      provider: "openai",
      label: "Kept key",
      apiKey: "kept-browser-fixture-1234",
    },
  });
  expect(saved.status()).toBe(201);
  await page.goto("/history");
  await expect(
    page.getByRole("list", { name: "Finished games" }).getByRole("listitem"),
  ).toHaveCount(3);
  await page.getByRole("button", { name: "Clear history", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Clear your game history?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(dialog).toContainText("games that finish after your history is cleared will remain");
  for (const width of testInfo.project.name === "desktop" ? [1024, 1440] : [320, 390, 768]) {
    await page.setViewportSize({ width, height: 800 });
    for (const enlarged of [false, true]) {
      await setPseudoLocalization(page, enlarged);
      await page.evaluate((large) => {
        document.documentElement.style.fontSize = large ? "200%" : "100%";
      }, enlarged);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      // The sheet scrolls internally so both actions stay reachable.
      for (const name of [/^Cancel/, /^Clear history/]) {
        const action = dialog.getByRole("button", { name });
        await action.scrollIntoViewIfNeeded();
        await expect(action).toBeInViewport();
      }
    }
  }
  await page.screenshot({ path: testInfo.outputPath("history-clear-enlarged.png") });
  await setPseudoLocalization(page, false);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "100%";
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await dialog.getByRole("button", { name: "Clear history", exact: true }).click();
  await expect(page.getByText("History cleared.", { exact: true })).toBeVisible();
  await expect(page.getByText(/No completed or aborted games yet/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear history", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(await readSnapshot(page, paused.gameId)).toEqual(paused);
  const credentials = credentialListResponseSchema.parse(
    await (await page.request.get(API_ORIGIN + "/credentials")).json(),
  );
  expect(credentials.credentials.map((credential) => credential.label)).toEqual(["Kept key"]);
});
