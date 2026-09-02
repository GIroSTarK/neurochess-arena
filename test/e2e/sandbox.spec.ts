import AxeBuilder from "@axe-core/playwright";
import { gameErrorResponseSchema, gameSnapshotSchema } from "@neurochess/contracts";

import { API_ORIGIN } from "./environment";
import {
  acceptedMove,
  activate,
  expect,
  playMove,
  readSnapshot,
  square,
  startSandbox,
  test,
} from "./fixtures";

const promotionApproach = ["a2a4", "h7h5", "a4a5", "h5h4", "a5a6", "h4h3", "a6b7", "h3g2"];

test("completes Fool's Mate, reads the persisted result, and starts a new game", async ({
  page,
}, testInfo) => {
  const touch = testInfo.project.name === "mobile-touch";
  let current = await startSandbox(page, touch);
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  for (const move of ["f2f3", "e7e5", "g2g4", "d8h4"]) {
    current = await playMove(page, current, move, touch);
  }
  await expect(page.getByRole("heading", { name: "Black wins" })).toBeVisible();
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
  await expect(square(page, "e1")).toHaveAttribute("data-check", "true");
  const restored = await readSnapshot(page, current.gameId);
  expect(restored).toEqual(current);
  expect(restored).toMatchObject({
    state: "completed",
    result: "0-1",
    terminationReason: "checkmate",
  });
  expect(restored.pgn).toContain("Qh4#");
  expect(restored.pgn.trim().endsWith("0-1")).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("checkmate.png"), fullPage: true });
  const creation = page.waitForResponse(
    (response) => response.url() === API_ORIGIN + "/sandbox/games" && response.status() === 201,
  );
  await activate(page.getByRole("button", { name: "New game" }), touch);
  const next = gameSnapshotSchema.parse(await (await creation).json());
  expect(next.gameId).not.toBe(current.gameId);
  expect(next.version).toBe(0);
  expect(next.moves).toEqual([]);
  await expect(page.getByRole("heading", { name: "White to move" })).toBeVisible();
});

test("promotes both colors from the standard position with modal cancellation and underpromotion", async ({
  page,
}, testInfo) => {
  const touch = testInfo.project.name === "mobile-touch";
  let current = await startSandbox(page, touch);
  for (const move of promotionApproach) current = await playMove(page, current, move, touch);
  await activate(square(page, "b7"), touch);
  await activate(square(page, "a8"), touch);
  const dialog = page.getByRole("dialog", { name: "Choose a piece for White on a8" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Promote to Queen" })).toBeFocused();
  await expect(square(page, "b7")).toHaveAttribute("aria-label", /White pawn/);
  expect(await readSnapshot(page, current.gameId)).toEqual(current);
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Promote to Queen" })).toBeFocused();
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  const choices = await dialog.locator(".promotion-choice").evaluateAll((elements) =>
    elements.map((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
      top: element.getBoundingClientRect().top,
    })),
  );
  expect(choices.every((choice) => choice.width >= 44 && choice.height >= 44)).toBe(true);
  if (touch) expect(new Set(choices.map((choice) => choice.top)).size).toBe(2);
  await page.screenshot({ path: testInfo.outputPath("promotion.png"), fullPage: true });
  if (touch) await activate(dialog.getByRole("button", { name: "Cancel" }), true);
  else await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(square(page, "a8")).toBeFocused();
  await expect(square(page, "b7")).toHaveAttribute("data-selected", "true");
  await activate(square(page, "a8"), touch);
  const response = page.waitForResponse((response) =>
    response.url().endsWith("/games/" + current.gameId + "/moves"),
  );
  await activate(dialog.getByRole("button", { name: "Promote to Knight" }), touch);
  current = await acceptedMove(await response, current, "b7a8n", page);
  current = await playMove(page, current, "g2h1r", touch);
  await expect(square(page, "a8").locator("[data-piece=white-n]")).toHaveCount(1);
  await expect(square(page, "h1").locator("[data-piece=black-r]")).toHaveCount(1);
  const restored = await readSnapshot(page, current.gameId);
  expect(restored).toEqual(current);
  expect(restored.fen).toBe("Nnbqkbnr/p1ppppp1/8/8/8/8/1PPPPP1P/RNBQKBNr w Qk - 0 6");
  expect(restored.moves.slice(-2).map((move) => move.uci)).toEqual(["b7a8n", "g2h1r"]);
});

test("reloads to the entry screen and explicitly reopens the unchanged active game", async ({
  page,
}, testInfo) => {
  const touch = testInfo.project.name === "mobile-touch";
  let current = await startSandbox(page, touch);
  current = await playMove(page, current, "e2e4", touch);
  await page.reload();
  await expect(page.getByRole("grid")).toHaveCount(0);
  const start = page.getByRole("button", { name: "Start sandbox", exact: true });
  await expect(start).toBeEnabled();
  const response = page.waitForResponse(
    (response) => response.url() === API_ORIGIN + "/sandbox/games" && response.status() === 409,
  );
  await activate(start, touch);
  const conflict = gameErrorResponseSchema.parse(await (await response).json());
  expect(conflict.code).toBe("GAME_CONFLICT");
  if (conflict.code !== "GAME_CONFLICT") throw new Error("Expected the current authorized game");
  expect(conflict.currentSnapshot).toEqual(current);
  await expect(
    page.getByText("You already have a game in progress. Your current position is open."),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Black to move" })).toBeVisible();
  expect((await readSnapshot(page, current.gameId)).state).toBe("active");
});
