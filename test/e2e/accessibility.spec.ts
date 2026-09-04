import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import type * as webI18n from "../../apps/web/src/i18n";

import { activate, expect, square, startSandbox, test } from "./fixtures";

async function checkBounds(page: Page) {
  const bounds = await page.evaluate(() => {
    const board = document.querySelector("[role=grid]")?.getBoundingClientRect();
    const summaries = [...document.querySelectorAll("[data-seat]")].map(
      (element) => element.getBoundingClientRect().width,
    );
    const controls = [...document.querySelectorAll("button:not([data-square]), summary")].map(
      (element) => element.getBoundingClientRect(),
    );
    return {
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      board: board
        ? { width: board.width, height: board.height, left: board.left, right: board.right }
        : null,
      viewport: document.documentElement.clientWidth,
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
      summaries,
      controlsReachable: controls.every(
        (rect) =>
          rect.left >= 0 &&
          rect.right <= document.documentElement.clientWidth + 1 &&
          rect.height >= 44,
      ),
      overflowing: [...document.querySelectorAll("body *")]
        .filter(
          (element) =>
            element.getBoundingClientRect().right > document.documentElement.clientWidth + 1,
        )
        .map((element) => ({
          tag: element.tagName,
          class: element.className,
          right: element.getBoundingClientRect().right,
        })),
    };
  });
  expect(bounds.overflow, JSON.stringify(bounds)).toBe(false);
  expect(bounds.board).not.toBeNull();
  expect(bounds.board?.width).toBeLessThanOrEqual(640);
  expect(Math.abs((bounds.board?.width ?? 0) - (bounds.board?.height ?? 0))).toBeLessThan(1);
  expect(bounds.board?.left).toBeGreaterThanOrEqual(15);
  expect(bounds.board?.right).toBeLessThanOrEqual(bounds.viewport - 15);
  expect(Math.abs((bounds.summaries[0] ?? 0) - (bounds.summaries[1] ?? 0))).toBeLessThan(1);
  expect(bounds.controlsReachable).toBe(true);
}

test("keeps keyboard-focused squares in view on short viewports in both orientations", async ({
  page,
}, testInfo) => {
  const touch = testInfo.project.name === "mobile-touch";
  await page.setViewportSize(touch ? { width: 390, height: 400 } : { width: 1280, height: 600 });
  await startSandbox(page, touch);

  async function navigateTo(key: string, coordinate: string) {
    await page.keyboard.press(key);
    const destination = square(page, coordinate);
    await expect(destination).toBeFocused();
    // Native focus scrolling rounds fractional square bounds to CSS pixels.
    await expect
      .poll(() =>
        destination.evaluate((element) => {
          const { top, right, bottom, left } = element.getBoundingClientRect();
          return Math.max(-top, -left, bottom - window.innerHeight, right - window.innerWidth);
        }),
      )
      .toBeLessThanOrEqual(1);
  }

  for (const orientation of ["white", "black"] as const) {
    if (orientation === "black") {
      await activate(page.getByRole("button", { name: "Flip board" }), touch);
    }
    await expect(page.getByRole("grid")).toHaveAttribute("data-orientation", orientation);
    const leftFile = orientation === "white" ? "a" : "h";
    const rightFile = orientation === "white" ? "h" : "a";
    const ranks =
      orientation === "white"
        ? ([1, 2, 3, 4, 5, 6, 7, 8] as const)
        : ([8, 7, 6, 5, 4, 3, 2, 1] as const);
    const first = leftFile + ranks[7];
    const last = rightFile + ranks[0];

    await activate(square(page, last), touch);
    await expect(square(page, first)).not.toBeInViewport();
    await navigateTo("Control+Home", first);
    await navigateTo("End", rightFile + ranks[7]);
    await navigateTo("Control+End", last);
    await navigateTo("Home", leftFile + ranks[0]);
    for (const rank of ranks.slice(1)) await navigateTo("ArrowUp", leftFile + rank);
    for (const rank of ranks.toReversed().slice(1)) await navigateTo("ArrowDown", leftFile + rank);
  }
});

test("supports keyboard inspection in both orientations, reflow, and enlarged localized text", async ({
  page,
}, testInfo) => {
  const touch = testInfo.project.name === "mobile-touch";
  await startSandbox(page, touch);
  await square(page, "e2").focus();
  await page.keyboard.press("Enter");
  await expect(square(page, "e2")).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("ArrowUp");
  await expect(square(page, "e3")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(square(page, "e2")).not.toHaveAttribute("data-selected");
  await page.keyboard.press("Control+Home");
  await expect(square(page, "a8")).toBeFocused();
  await page.keyboard.press("Control+End");
  await expect(square(page, "h1")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Flip board" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("grid")).toHaveAttribute("data-orientation", "black");
  await expect(square(page, "h1")).toHaveAttribute("tabindex", "0");
  await square(page, "e2").focus();
  await page.keyboard.press("ArrowRight");
  await expect(square(page, "d2")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(square(page, "d3")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(square(page, "h3")).toBeFocused();
  await page.keyboard.press("End");
  await expect(square(page, "a3")).toBeFocused();
  const focus = await square(page, "a3").evaluate((element) => {
    const frame = element.closest("[data-testid=arena-frame]");
    return {
      keyline: getComputedStyle(element).boxShadow,
      clip: frame ? getComputedStyle(frame).clipPath : null,
    };
  });
  expect(focus.keyline).not.toBe("none");
  expect(focus.clip).toBe("none");
  expect(
    await page
      .locator("[data-square]")
      .evaluateAll(
        (squares) => squares.filter((element) => (element as HTMLElement).tabIndex === 0).length,
      ),
  ).toBe(1);
  await activate(page.getByRole("button", { name: "Flip board" }), touch);
  for (const width of touch ? [320, 390] : [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await checkBounds(page);
    await page.screenshot({
      path: testInfo.outputPath("layout-" + width + ".png"),
      fullPage: true,
    });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  const animations = await page
    .getByRole("button", { name: "Flip board" })
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(animations).toBe("0s");
  await page.setViewportSize({ width: 320, height: 900 });
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await checkBounds(page);
  await page.screenshot({ path: testInfo.outputPath("text-200-percent.png"), fullPage: true });
  // Test-only resource expansion. No locale switcher, query flag, browser
  // detection or fixture code is bundled into the application.
  await page.evaluate(async () => {
    const modulePath = "/src/i18n/index.ts";
    const { i18n } = (await import(/* @vite-ignore */ modulePath)) as typeof webI18n;
    function expand(value: unknown): unknown {
      if (typeof value === "string") return value + " extra".repeat(Math.ceil(value.length / 12));
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, expand(entry)]),
        );
      }
      return value;
    }
    i18n.addResourceBundle(
      "en-XA",
      "translation",
      expand(i18n.getResourceBundle("en", "translation")),
    );
    await i18n.changeLanguage("en-XA");
  });
  await checkBounds(page);
  await page.screenshot({ path: testInfo.outputPath("expanded-translation.png"), fullPage: true });
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});
