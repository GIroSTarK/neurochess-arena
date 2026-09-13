import type { Page } from "@playwright/test";

import { expect } from "./fixtures";
import { expectUnbrokenWords } from "./text-layout";

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
