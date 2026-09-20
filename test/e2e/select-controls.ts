import type { Locator } from "@playwright/test";

import { expect } from "./fixtures";

export async function expectSelectArrowSpacing(select: Locator) {
  const spacing = await select.evaluate((element) => {
    const arrow = element.parentElement?.querySelector("svg");
    if (!arrow) throw new Error("Select arrow missing");
    const field = element.getBoundingClientRect();
    const icon = arrow.getBoundingClientRect();
    return {
      inset: field.right - icon.right,
      expected: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.75,
      center: icon.top + icon.height / 2 - (field.top + field.height / 2),
      textPadding: Number.parseFloat(getComputedStyle(element).paddingInlineEnd),
      iconWidth: icon.width,
    };
  });
  expect(spacing.inset).toBeCloseTo(spacing.expected, 1);
  expect(spacing.center).toBeCloseTo(0, 1);
  expect(spacing.textPadding).toBeGreaterThan(spacing.inset + spacing.iconWidth);
}
