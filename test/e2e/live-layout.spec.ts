import type { Locator } from "@playwright/test";

import { activate, expect, playMove, square, startSandbox, test } from "./fixtures";

async function bounds(locator: Locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top + window.scrollY,
      bottom: rect.bottom + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  });
}

test("keeps live status above the board and game controls below it", async ({ page }, testInfo) => {
  const touch = testInfo.project.name === "mobile-touch";
  await page.setViewportSize(touch ? { width: 390, height: 844 } : { width: 1440, height: 1100 });
  let snapshot = await startSandbox(page, touch);
  for (const move of ["f2f3", "e7e5", "g2g4"]) {
    snapshot = await playMove(page, snapshot, move, touch);
  }
  const board = page.getByRole("grid", { name: "Chessboard" });
  const history = page.getByRole("region", { name: "Moves", exact: true });
  const controls = page.getByRole("group", { name: "Game controls" });
  const pause = page.getByRole("button", { name: "Pause", exact: true });
  const flip = page.getByRole("button", { name: "Flip board", exact: true });
  const abort = page.getByRole("button", { name: "Abort game", exact: true });
  const resignWhite = page.getByRole("button", { name: "Resign White", exact: true });
  const resignBlack = page.getByRole("button", { name: "Resign Black", exact: true });
  const help = page.getByRole("button", { name: "Keyboard controls", exact: true });
  const title = page.getByRole("heading", { name: "Sandbox", exact: true });
  const turn = page.getByRole("heading", { name: "Black to move", exact: true });
  await expect(turn).toBeVisible();
  await expect(board).toHaveAttribute("data-fen", snapshot.fen);
  await page.evaluate(() => document.fonts.ready);
  const initial = await bounds(board);
  const beforeControls = await bounds(controls);
  const beforeHistory = await bounds(history);
  async function checkButtonSizing(primary: Locator) {
    const primaryBounds = await bounds(primary);
    const flipBounds = await bounds(flip);
    const whiteBounds = await bounds(resignWhite);
    const blackBounds = await bounds(resignBlack);
    expect(Math.abs(primaryBounds.width - flipBounds.width)).toBeLessThan(1);
    expect(Math.abs(whiteBounds.width - blackBounds.width)).toBeLessThan(1);
    if (!touch) {
      const helpBounds = await bounds(help);
      expect(Math.abs(whiteBounds.top - blackBounds.top)).toBeLessThan(1);
      expect(Math.abs(blackBounds.top - helpBounds.top)).toBeLessThan(1);
      const firstGap = blackBounds.left - whiteBounds.right;
      const secondGap = helpBounds.left - blackBounds.right;
      expect(firstGap).toBeGreaterThan(0);
      expect(Math.abs(firstGap - secondGap)).toBeLessThan(1);
      for (const button of [resignWhite, resignBlack, help]) {
        const label = await button.locator(":scope > span").evaluate((element) => ({
          text: (element as HTMLElement).innerText,
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
        }));
        expect(
          label.height,
          `Desktop toolbar label must fit on one line: ${label.text}`,
        ).toBeLessThanOrEqual(label.lineHeight + 1);
      }
    }
  }
  await checkButtonSizing(pause);
  expect((await bounds(turn)).bottom).toBeLessThan(initial.top);
  expect((await bounds(pause)).top).toBeGreaterThan(initial.bottom);
  expect(Math.abs((await bounds(pause)).top - (await bounds(flip)).top)).toBeLessThan(1);
  if (touch) {
    expect(initial.width).toBeCloseTo(358, 0);
    expect(beforeHistory.top).toBeGreaterThan(beforeControls.bottom);
    expect((await bounds(abort)).top).toBeGreaterThan((await bounds(pause)).bottom);
  } else {
    expect(beforeHistory.left).toBeGreaterThan(initial.right);
    expect(beforeHistory.top).toBeLessThan(initial.top);
    expect(Math.abs((await bounds(pause)).top - (await bounds(abort)).top)).toBeLessThan(1);
  }
  await activate(title, touch);
  await page.screenshot({ path: testInfo.outputPath("live.png"), fullPage: true });
  await activate(pause, touch);
  await expect(page.getByRole("heading", { name: /^Game paused ·/ })).toBeVisible();
  const resume = page.getByRole("button", { name: "Resume", exact: true });
  await checkButtonSizing(resume);
  await expect(resume).toBeFocused();
  expect(Math.abs((await bounds(board)).top - initial.top)).toBeLessThan(1);
  expect(Math.abs((await bounds(controls)).top - beforeControls.top)).toBeLessThan(1);
  expect(Math.abs((await bounds(history)).top - beforeHistory.top)).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath("paused.png"), fullPage: true });
  await controls.screenshot({ path: testInfo.outputPath("paused-toolbar.png") });
  await activate(flip, touch);
  await expect(board).toHaveAttribute("data-orientation", "black");
  await expect(square(page, "h1")).toHaveAccessibleName(/h1: White rook/);
  await activate(resume, touch);
  await expect(turn).toBeVisible();
  await expect(board).toHaveAttribute("data-fen", snapshot.fen);
  await activate(help, touch);
  await expect(help).toHaveAttribute("aria-expanded", "true");
  await activate(help, touch);
  await expect(help).toHaveAttribute("aria-expanded", "false");
});
