import AxeBuilder from "@axe-core/playwright";

import { expectArenaLayout } from "./arena-layout";
import { activate, expect, square, startSandbox, test } from "./fixtures";
import { setPseudoLocalization } from "./text-layout";

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
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeFocused();
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
    await expectArenaLayout(page);
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
  await expectArenaLayout(page);
  await page.screenshot({ path: testInfo.outputPath("text-200-percent.png"), fullPage: true });
  await setPseudoLocalization(page, true);
  await expectArenaLayout(page);
  await page.screenshot({ path: testInfo.outputPath("expanded-translation.png"), fullPage: true });
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
});
