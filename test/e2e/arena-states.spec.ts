import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

import { API_ORIGIN } from "./environment";
import { activate, expect, playMove, readSnapshot, square, startSandbox, test } from "./fixtures";

const widths = [320, 390, 768, 1024, 1440];
const initialFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

async function bounds(locator: Locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top + scrollY,
      bottom: rect.bottom + scrollY,
      left: rect.left,
      right: rect.right,
      width: rect.width,
    };
  });
}

async function checkViewport(page: Page) {
  const layout = await page.evaluate(() => {
    const board = document.querySelector('[role="grid"]')!.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const controls = [...document.querySelectorAll("button:not([data-square])")].filter((element) =>
      element.checkVisibility(),
    );
    return {
      overflow: document.documentElement.scrollWidth > width,
      square: Math.abs(board.width - board.height) < 1,
      boardWidth: board.width,
      controlsFit: controls.every((element) => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= width && rect.height >= 44;
      }),
    };
  });
  expect(layout.overflow).toBe(false);
  expect(layout.square).toBe(true);
  expect(layout.boardWidth).toBeLessThanOrEqual(640);
  expect(layout.controlsFit).toBe(true);
}

test("entry previews standard chess without creating a guest and places one Start before mobile play", async ({
  page,
}, testInfo) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") writes.push(new URL(request.url()).pathname);
  });
  await page.goto("/");
  await expect(page).toHaveTitle("Development sandbox · Neurochess Arena");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  const start = page.getByRole("button", { name: "Start sandbox", exact: true });
  const board = page.getByRole("grid", { name: "Chessboard" });
  await expect(start).toHaveAttribute("aria-disabled", "false");
  await expect(start).toHaveCount(1);
  await expect(board).toHaveAttribute("aria-readonly", "true");
  await expect(board).toHaveAttribute("data-fen", initialFen);
  await square(page, "e2").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(board).toHaveAttribute("data-fen", initialFen);
  await expect(page.getByRole("region", { name: "Move history" })).toHaveCount(0);
  expect(writes).toEqual([]);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1080 });
    await checkViewport(page);
    const play = await bounds(page.getByRole("region", { name: "Play area" }));
    const action = await bounds(start);
    if (width <= 1024) expect(action.bottom).toBeLessThan(play.top);
    else expect(action.left).toBeGreaterThan(play.right);
    if (width === 320) expect((await bounds(board)).width).toBeCloseTo(288, 0);
  }
  await page.setViewportSize(testInfo.project.use.viewport!);
  await page.getByRole("heading", { name: "Sandbox", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("entry.png"), fullPage: true });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});

test("recovery and result retain the arena composition, explicit Resume and final result during replay", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const touch = testInfo.project.name === "mobile-touch";
  let current = await startSandbox(page, touch);
  for (const move of ["f2f3", "e7e5", "g2g4"]) current = await playMove(page, current, move, touch);
  await page.reload();
  const resume = page.getByRole("button", { name: "Resume", exact: true });
  await expect(resume).toHaveAttribute("aria-disabled", "false");
  await expect(page.getByRole("heading", { name: "Game paused · Black to move" })).toBeVisible();
  const board = page.getByRole("grid");
  await expect(board).toHaveAttribute("data-fen", current.fen);
  await expect(board).toHaveAttribute("aria-readonly", "true");
  const recovered = page.getByRole("heading", { name: "Game recovered", exact: true });
  await expect(recovered).toHaveCount(1);
  const recovery = await bounds(recovered);
  const history = await bounds(page.getByRole("region", { name: "Move history" }));
  if (touch) {
    expect(recovery.top).toBeGreaterThan((await bounds(board)).bottom);
    expect(recovery.bottom).toBeLessThan((await bounds(resume)).top);
  } else {
    expect(recovery.left).toBeGreaterThan((await bounds(board)).right);
    expect(recovery.top).toBeGreaterThan(history.bottom);
  }
  await page.getByRole("heading", { name: "Sandbox", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("recovery.png"), fullPage: true });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);

  const release = Promise.withResolvers<void>();
  await page.route(API_ORIGIN + "/games/*/lifecycle", async (route) => {
    await release.promise;
    await route.continue();
  });
  try {
    await resume.scrollIntoViewIfNeeded();
    const before = await bounds(resume);
    await activate(resume, touch);
    await expect(resume).toHaveAttribute("aria-disabled", "true");
    await expect(recovered).toHaveCount(1);
    expect((await bounds(resume)).top).toBeCloseTo(before.top, 0);
    await expect(resume).toBeFocused();
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: "wait" });
  }
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  current = await readSnapshot(page, current.gameId);
  current = await playMove(page, current, "d8h4", touch);
  const result = page.getByRole("heading", { name: "Black wins by checkmate", level: 1 });
  await expect(result).toBeVisible();
  const replay = page.getByRole("region", { name: "Replay", exact: true });
  const exports = page.getByRole("region", { name: "Private PGN" });
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1080 });
    await checkViewport(page);
    expect((await bounds(replay)).top).toBeGreaterThan((await bounds(board)).bottom);
    expect((await bounds(exports)).top).toBeGreaterThan((await bounds(replay)).bottom);
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await checkViewport(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  await page.setViewportSize(testInfo.project.use.viewport!);
  await result.click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("replay.png"), fullPage: true });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  const first = page.getByRole("button", { name: "First", exact: true });
  await activate(first, touch);
  await expect(board).toHaveAttribute("data-fen", initialFen);
  await expect(result).toBeVisible();
  await expect(page.getByLabel("Result: 0-1", { exact: true })).toHaveText("0–1");
  await expect(
    page.getByText("Sandbox · Game complete · 2... Qh4#", { exact: true }),
  ).toBeVisible();
  await first.focus();
  await expect(page.getByRole("tooltip", { name: "First", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip", { name: "First", exact: true })).toHaveCount(0);
  expect(await readSnapshot(page, current.gameId)).toEqual(current);
});
