import {
  type LifecycleCommand,
  lifecycleCommandSchema,
  type MoveCommand,
  moveCommandSchema,
} from "@neurochess/contracts";

import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, playMove, readSnapshot, square, startSandbox, test } from "./fixtures";

for (const operation of ["move", "pause", "recovery"] as const) {
  test(`resolves an uncertain ${operation} only through an identical explicit retry`, async ({
    page,
  }, testInfo) => {
    const touch = testInfo.project.name === "mobile-touch";
    const initial = await startSandbox(page, touch);
    const current = await playMove(page, initial, "e2e4", touch);
    const commandUrl =
      API_ORIGIN + "/games/" + current.gameId + (operation === "move" ? "/moves" : "/lifecycle");
    const commands: (MoveCommand | LifecycleCommand)[] = [];
    const release = Promise.withResolvers<void>();
    await page.route(commandUrl, async (route) => {
      commands.push(
        operation === "move"
          ? moveCommandSchema.parse(route.request().postDataJSON())
          : lifecycleCommandSchema.parse(route.request().postDataJSON()),
      );
      if (commands.length === 1) {
        // Lose the acknowledgement before execution. Reads and the explicit retry use the real API.
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: {
            "access-control-allow-origin": WEB_ORIGIN,
            "access-control-allow-credentials": "true",
          },
          body: JSON.stringify({ message: "Untrusted acknowledgement text" }),
        });
      } else {
        const response = await route.fetch();
        await release.promise;
        await route.fulfill({ response });
      }
    });
    try {
      if (operation === "recovery") await page.reload();
      else if (operation === "pause") {
        await page.getByRole("button", { name: "Pause", exact: true }).focus();
        await page.keyboard.press("Enter");
      } else {
        await square(page, "e7").focus();
        await page.keyboard.press("Enter");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
      }
      const retry = page.getByRole("button", {
        name: operation === "move" ? "Retry same move" : "Retry same command",
        exact: true,
      });
      await expect(retry).toBeVisible();
      const board = page.getByRole("grid");
      await expect(board).toHaveAttribute("data-fen", current.fen);
      await expect(board).toHaveAttribute("aria-readonly", "true");
      await expect(page.getByRole("region", { name: "Moves", exact: true })).toContainText("1 ply");
      await expect(page.getByText("Untrusted acknowledgement text")).toHaveCount(0);
      expect(await readSnapshot(page, current.gameId)).toEqual(current);
      expect(commands).toHaveLength(1);

      await page.getByRole("button", { name: "Check game status", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(retry).toBeVisible();
      await expect(board).toHaveAttribute("aria-readonly", "true");
      for (const action of ["Pause", "Resign White", "Resign Black", "Abort game"]) {
        const control = page.getByRole("button", { name: action, exact: true });
        await expect(control).toHaveAttribute("aria-disabled", "true");
        await control.focus();
        await page.keyboard.press("Enter");
        await expect(control).toBeFocused();
      }
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await square(page, "d7").focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Space");
      await expect(square(page, "d6")).toBeFocused();
      await expect(board).toHaveAttribute("data-fen", current.fen);
      expect(commands).toHaveLength(1);
      await page.screenshot({
        path: testInfo.outputPath(`uncertain-${operation}.png`),
        fullPage: true,
      });

      await retry.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => commands.length).toBe(2);
      await expect(board).toHaveAttribute("aria-readonly", "true");
      await expect(board).toHaveAttribute("data-fen", current.fen);
      await square(page, "e2").focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
      release.resolve();
      await expect(
        page.getByRole("heading", {
          name: operation === "move" ? "White to move" : "Game paused · Black to move",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: operation === "move" ? "Pause" : "Resume", exact: true }),
      ).toHaveAttribute("aria-disabled", "false");
      await expect(square(page, "e2")).toBeFocused();
      expect(commands).toHaveLength(2);
      expect(commands[1]).toEqual(commands[0]);
      const accepted = await readSnapshot(page, current.gameId);
      expect(accepted.version).toBe(current.version + 1);
      expect(accepted.moves.map((move) => move.uci)).toEqual(
        operation === "move" ? ["e2e4", "e7e5"] : ["e2e4"],
      );
      expect(accepted.state).toBe(operation === "move" ? "active" : "paused");
      await expect(board).toHaveAttribute("data-fen", accepted.fen);
      await expect(retry).toHaveCount(0);
    } finally {
      release.resolve();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}

test("adopts an already committed move after a lost acknowledgement without submitting it again", async ({
  page,
}, testInfo) => {
  const touch = testInfo.project.name === "mobile-touch";
  const current = await startSandbox(page, touch);
  let submissions = 0;
  await page.route(API_ORIGIN + "/games/" + current.gameId + "/moves", async (route) => {
    submissions += 1;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.fulfill({ response, body: "{}" });
  });
  await square(page, "e2").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Black to move", exact: true })).toBeVisible();
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  await expect(square(page, "e4")).toBeFocused();
  await expect(page.getByRole("button", { name: "Retry same move" })).toHaveCount(0);
  const accepted = await readSnapshot(page, current.gameId);
  expect(accepted.version).toBe(current.version + 1);
  expect(accepted.moves.map((move) => move.uci)).toEqual(["e2e4"]);
  await expect(page.getByRole("grid")).toHaveAttribute("data-fen", accepted.fen);
  expect(submissions).toBe(1);
});

test("replaces a stale board with the complete accepted position without repeating the rejected move", async ({
  page,
}, testInfo) => {
  const current = await startSandbox(page, testInfo.project.name === "mobile-touch");
  await square(page, "d2").focus();
  await page.keyboard.press("Enter");
  await expect(square(page, "d2")).toHaveAttribute("data-selected", "true");
  const otherWindow = await page.request.post(API_ORIGIN + "/games/" + current.gameId + "/moves", {
    headers: { Origin: WEB_ORIGIN },
    data: {
      gameId: current.gameId,
      expectedVersion: current.version,
      commandId: crypto.randomUUID(),
      move: "e2e4",
    },
  });
  expect(otherWindow.status()).toBe(200);
  const accepted = await readSnapshot(page, current.gameId);
  const rejection = page.waitForResponse(
    (response) => response.url().endsWith("/moves") && response.status() === 409,
  );
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await rejection;
  await expect(page.getByRole("grid")).toHaveAttribute("data-fen", accepted.fen);
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  await expect(page.locator("[data-selected=true]")).toHaveCount(0);
  await expect(square(page, "d4")).toBeFocused();
  await expect(square(page, "d2").locator("[data-piece=white-p]")).toHaveCount(1);
  expect(await readSnapshot(page, current.gameId)).toEqual(accepted);
});
