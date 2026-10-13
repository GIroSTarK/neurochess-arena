import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page, TestInfo } from "@playwright/test";

import { expectArenaLayout } from "./arena-layout";
import { API_ORIGIN } from "./environment";
import { activate, expect, playMove, readSnapshot, square, startSandbox, test } from "./fixtures";
import { setPseudoLocalization } from "./text-layout";

const widths = [320, 390, 768, 1024, 1440];
// Keep the 1024px boundary in both device contexts; interaction still uses each default viewport.
const desktopWidths = [1024, 1440];
const mobileWidths = [320, 390, 768, 1024];
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

async function checkLayouts(
  page: Page,
  testInfo: TestInfo,
  state: "entry" | "live" | "recovery" | "replay",
  checkComposition?: (width: number) => Promise<void>,
) {
  // Replay's scrollable move list has different native gutter geometry in the two contexts.
  const stateWidths =
    state === "replay" ? widths : testInfo.project.use.isMobile ? mobileWidths : desktopWidths;
  const viewport = page.viewportSize()!;
  const board = page.getByRole("grid");
  const fen = await board.getAttribute("data-fen");
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    for (const enlarged of [false, true]) {
      if (enlarged) {
        await setPseudoLocalization(page, true);
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "200%";
        });
      }
      for (const width of stateWidths) {
        await page.setViewportSize({ width, height: 1080 });
        await page.evaluate(() => document.fonts.ready);
        await expectArenaLayout(page);
        await expect(board).toHaveAttribute("data-fen", fen!);
        await expect(board.getByRole("gridcell")).toHaveCount(64);
        await expect(board.locator("[data-piece]")).toHaveCount(32);
        if (!enlarged) await checkComposition?.(width);
        const moving = await page.locator("body *").evaluateAll((elements) =>
          elements
            .filter((element) => element.checkVisibility())
            .some((element) => {
              const style = getComputedStyle(element);
              return (
                style.transitionDuration
                  .split(",")
                  .some((duration) => Number.parseFloat(duration) > 0) ||
                (style.animationName !== "none" &&
                  style.animationDuration
                    .split(",")
                    .some((duration) => Number.parseFloat(duration) > 0))
              );
            }),
        );
        expect(moving, "Reduced motion must suppress transitions and animations").toBe(false);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: testInfo.outputPath(`${state}-${width}${enlarged ? "-enlarged" : ""}.png`),
          fullPage: true,
        });
        if (state === "live" && width === 320 && enlarged) {
          await page.getByRole("group", { name: /^Game controls/ }).screenshot({
            path: testInfo.outputPath("controls-320-enlarged.png"),
          });
        }
      }
    }
  } catch (error) {
    await page.screenshot({
      path: testInfo.outputPath(`${state}-reflow-failed.png`),
      fullPage: true,
    });
    throw error;
  } finally {
    await setPseudoLocalization(page, false);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: null });
  }
}

test("entry previews standard chess without creating a guest and places one Start before mobile play", async ({
  page,
}, testInfo) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") writes.push(new URL(request.url()).pathname);
  });
  await page.goto("/sandbox");
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
  await checkLayouts(page, testInfo, "entry", async (width) => {
    const play = await bounds(page.getByRole("region", { name: "Play area" }));
    const action = await bounds(start);
    if (width <= 1024) expect(action.bottom).toBeLessThan(play.top);
    else expect(action.left).toBeGreaterThan(play.right);
    if (width === 320) expect((await bounds(board)).width).toBeCloseTo(288, 0);
  });
  expect(writes).toEqual([]);
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
  test.setTimeout(90_000);
  const touch = Boolean(testInfo.project.use.hasTouch);
  let current = await startSandbox(page, touch);
  for (const move of ["f2f3", "e7e5", "g2g4"]) current = await playMove(page, current, move, touch);
  await expect(page.getByRole("grid")).toHaveAttribute(
    "data-fen",
    "rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2",
  );
  await checkLayouts(page, testInfo, "live", async (width) => {
    const board = await bounds(page.getByRole("grid"));
    const controls = await bounds(page.getByRole("group", { name: "Game controls" }));
    const moves = await bounds(page.getByRole("region", { name: "Moves", exact: true }));
    expect(controls.top).toBeGreaterThan(board.bottom);
    if (width <= 1024) expect(moves.top).toBeGreaterThan(controls.bottom);
    else expect(moves.left).toBeGreaterThan(board.right);
  });
  await page.reload();
  const resume = page.getByRole("button", { name: "Resume", exact: true });
  await expect(resume).toHaveAttribute("aria-disabled", "false");
  await expect(page.getByRole("heading", { name: "Game paused · Black to move" })).toBeVisible();
  const board = page.getByRole("grid");
  await expect(board).toHaveAttribute("data-fen", current.fen);
  await expect(board).toHaveAttribute("aria-readonly", "true");
  const recovered = page.getByRole("heading", { name: "Game recovered", exact: true });
  await expect(recovered).toHaveCount(1);
  await expect(square(page, "e2")).not.toBeFocused();
  await checkLayouts(page, testInfo, "recovery", async (width) => {
    const recovery = await bounds(recovered);
    const history = await bounds(page.getByRole("region", { name: "Move history" }));
    if (width <= 1024) {
      expect(recovery.top).toBeGreaterThan((await bounds(board)).bottom);
      expect(recovery.bottom).toBeLessThan((await bounds(resume)).top);
    } else {
      expect(recovery.left).toBeGreaterThan((await bounds(board)).right);
      expect(recovery.top).toBeGreaterThan(history.bottom);
    }
  });
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
  await expect(board).toHaveAttribute(
    "data-fen",
    "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3",
  );
  await checkLayouts(page, testInfo, "replay", async () => {
    expect((await bounds(replay)).top).toBeGreaterThan((await bounds(board)).bottom);
    expect((await bounds(exports)).top).toBeGreaterThan((await bounds(replay)).bottom);
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
  });
  await page.setViewportSize(testInfo.project.use.viewport!);
  await result.click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("replay.png"), fullPage: true });
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  const scoreAccessibility = await new AxeBuilder({ page })
    .include('[data-testid="game-score"]')
    .withRules(["aria-prohibited-attr"])
    .analyze();
  expect(scoreAccessibility.violations).toEqual([]);
  expect(scoreAccessibility.incomplete).toEqual([]);
  const first = page.getByRole("button", { name: "First", exact: true });
  await activate(first, touch);
  await expect(board).toHaveAttribute("data-fen", initialFen);
  await expect(result).toBeVisible();
  await expect(page.getByTestId("game-score")).toMatchAriaSnapshot('- text: "Result: 0-1"');
  await expect(page.getByText("0–1", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Sandbox · Game complete · 2... Qh4#", { exact: true }),
  ).toBeVisible();
  for (const name of ["First", "Previous", "Next", "Last"]) {
    const control = replay.getByRole("button", { name, exact: true });
    const tooltip = replay.getByRole("tooltip", { name, exact: true });
    await expect(control).toHaveAccessibleName(name);
    await expect(control).toHaveAccessibleDescription("");
    await control.focus();
    await expect(tooltip).toBeVisible();
    await expect(control).toHaveAccessibleName(name);
    await expect(control).toHaveAccessibleDescription("");
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);
    await expect(control).toBeFocused();
    await expect(control).toHaveAccessibleName(name);
    await expect(control).toHaveAccessibleDescription("");
  }
  expect(await readSnapshot(page, current.gameId)).toEqual(current);
});

test("PGN export labels wrap between words on narrow screens with increased text spacing", async ({
  page,
}, testInfo) => {
  const touch = Boolean(testInfo.project.use.hasTouch);
  let current = await startSandbox(page, touch);
  for (const move of ["f2f3", "e7e5", "g2g4", "d8h4"]) {
    current = await playMove(page, current, move, touch);
  }
  const exports = page.getByRole("region", { name: "Private PGN" });
  await expect(exports.getByRole("button", { name: "Download PGN", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 1080 });
  await page.evaluate(() => document.fonts.ready);
  await exports.evaluate((element) => {
    element.style.letterSpacing = "0.12em";
  });
  await expectArenaLayout(page);
  for (const button of await exports.getByRole("button").all()) {
    expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  }
});
