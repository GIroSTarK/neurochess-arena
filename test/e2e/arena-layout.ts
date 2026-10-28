import type { Page } from "@playwright/test";

import { expect } from "./fixtures";
import { expectUnbrokenWords } from "./text-layout";

export async function isArenaWide(page: Page) {
  return page.getByTestId("arena-frame").evaluate((frame) => {
    const play = frame.querySelector(":scope > section")!.getBoundingClientRect();
    const details = frame.querySelector("aside")!.getBoundingClientRect();
    return details.left >= play.right;
  });
}

export async function arenaTransitionWidth(page: Page) {
  const viewport = page.viewportSize()!;
  let stacked = 768;
  let wide = 1440;
  await page.setViewportSize({ ...viewport, width: stacked });
  expect(await isArenaWide(page)).toBe(false);
  await page.setViewportSize({ ...viewport, width: wide });
  expect(await isArenaWide(page)).toBe(true);
  while (wide - stacked > 1) {
    const width = Math.floor((stacked + wide) / 2);
    await page.setViewportSize({ ...viewport, width });
    if (await isArenaWide(page)) wide = width;
    else stacked = width;
  }
  return wide;
}

export async function expectArenaTransition(page: Page) {
  const viewport = page.viewportSize()!;
  const transition = await arenaTransitionWidth(page);
  let previousBoardWidth = 0;
  for (const width of [transition - 1, transition, transition + 1]) {
    await page.setViewportSize({ ...viewport, width });
    await expectArenaLayout(page);
    const boardWidth = await page
      .getByRole("grid")
      .evaluate((board) => board.getBoundingClientRect().width);
    expect(boardWidth, `Board shrank at viewport ${width}px`).toBeGreaterThanOrEqual(
      previousBoardWidth - 1,
    );
    expect(boardWidth).toBeCloseTo(640, 0);
    previousBoardWidth = boardWidth;
    expect(await isArenaWide(page)).toBe(width >= transition);
  }
  await page.setViewportSize(viewport);
  return transition;
}

export async function expectArenaLayout(page: Page) {
  const controlSelector = "button:not([data-square]), summary";
  const layout = await page.evaluate((controlSelector) => {
    const board = document.querySelector('[role="grid"]')?.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    const controls = [...document.querySelectorAll(controlSelector)]
      .filter((element) => element.checkVisibility())
      .map((element) => element.getBoundingClientRect());
    return {
      overflow: document.documentElement.scrollWidth > viewport,
      board: board
        ? { width: board.width, height: board.height, left: board.left, right: board.right }
        : null,
      viewport,
      scrollWidth: document.documentElement.scrollWidth,
      textOverflow: [...document.querySelectorAll("body *")]
        .filter(
          (element) =>
            element.scrollWidth > element.clientWidth &&
            getComputedStyle(element).overflowX === "visible",
        )
        .map((element) => ({
          tag: element.tagName,
          class: typeof element.className === "string" ? element.className : "svg",
          client: element.clientWidth,
          scroll: element.scrollWidth,
        })),
      seats: [...document.querySelectorAll("[data-seat]")].map(
        (element) => element.getBoundingClientRect().width,
      ),
      controlsFit: controls.every(
        (rect) =>
          rect.left >= 0 && rect.right <= viewport + 1 && rect.height >= 44 && rect.width >= 44,
      ),
      overflowing: [...document.querySelectorAll("body *")]
        .filter((element) => element.getBoundingClientRect().right > viewport + 1)
        .map((element) => ({
          tag: element.tagName,
          class: element.className,
          right: element.getBoundingClientRect().right,
        })),
    };
  }, controlSelector);
  const diagnostics = JSON.stringify(layout);
  expect(layout.overflow, diagnostics).toBe(false);
  expect(layout.board, diagnostics).not.toBeNull();
  expect(layout.board?.width, diagnostics).toBeLessThanOrEqual(640);
  expect(
    Math.abs((layout.board?.width ?? 0) - (layout.board?.height ?? 0)),
    diagnostics,
  ).toBeLessThan(1);
  expect(layout.board?.left, diagnostics).toBeGreaterThanOrEqual(15);
  expect(layout.board?.right, diagnostics).toBeLessThanOrEqual(layout.viewport - 15);
  expect(layout.seats, diagnostics).toHaveLength(2);
  expect(layout.seats[0], diagnostics).toBeCloseTo(layout.seats[1]!, 0);
  expect(layout.controlsFit, diagnostics).toBe(true);
  await expectUnbrokenWords(page.locator(`${controlSelector}, [data-seat]`));
}
