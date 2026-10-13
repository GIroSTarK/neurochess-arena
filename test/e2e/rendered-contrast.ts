import type { Page } from "@playwright/test";

import { expect } from "./fixtures";

// Axe cannot measure SVG artwork or the board's layered state/focus keylines.
export async function expectRenderedContrast(page: Page) {
  // A control that just changed state can still be fading its background while its text
  // color has already switched; measure the settled colors.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === "running" &&
            Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)),
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  const checks = await page.evaluate(() => {
    const rgb = (color: string) =>
      color
        .match(/[\d.]+/g)!
        .slice(0, 3)
        .map(Number);
    const luminance = (color: string) => {
      const linear = rgb(color).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
    };
    const contrast = (a: string, b: string) => {
      const first = luminance(a);
      const second = luminance(b);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };
    const background = (element: Element): string => {
      const value = getComputedStyle(element).backgroundColor;
      if (value !== "rgba(0, 0, 0, 0)") return value;
      return element.parentElement ? background(element.parentElement) : "rgb(2, 9, 20)";
    };
    const result: { name: string; ratio: number; minimum: number }[] = [];
    const check = (name: string, a: string, b: string, minimum = 3) =>
      result.push({ name, ratio: contrast(a, b), minimum });

    const darkSquare = document.querySelector('[data-square="a1"]');
    const lightSquare = document.querySelector('[data-square="a2"]');
    if (darkSquare && lightSquare) {
      check("adjacent squares", background(darkSquare), background(lightSquare));
    }

    for (const square of document.querySelectorAll<HTMLElement>("[data-square]")) {
      const style = getComputedStyle(square);
      const name = square.dataset.square!;
      const bg = style.backgroundColor;
      const piece = square.querySelector("[data-piece]");
      if (piece) {
        const inks = getComputedStyle(piece);
        check(`${name} piece outline`, inks.fill, inks.stroke);
        result.push({
          name: `${name} piece against square`,
          ratio: Math.max(contrast(inks.fill, bg), contrast(inks.stroke, bg)),
          minimum: 3,
        });
      }
      check(`${name} coordinate ink`, style.color, bg, 4.5);
      if (square.matches(":focus-visible")) {
        const inks = style.boxShadow.match(/rgb\([^)]+\)/g)!;
        check(`${name} focus keylines`, inks[0], inks[1]!);
        result.push({
          name: `${name} focus against square`,
          ratio: Math.max(...inks.map((ink) => contrast(ink, bg))),
          minimum: 3,
        });
      }
      for (const mark of square.querySelectorAll<HTMLElement>("span")) {
        const markStyle = getComputedStyle(mark);
        if (markStyle.borderTopStyle === "solid" && parseFloat(markStyle.borderTopWidth) > 0) {
          const light = /rgb\([^)]+\)/.exec(markStyle.boxShadow)?.[0] ?? markStyle.borderTopColor;
          const dark =
            markStyle.backgroundColor === "rgba(0, 0, 0, 0)"
              ? markStyle.borderTopColor
              : markStyle.backgroundColor;
          result.push({
            name: `${name} overlay against square`,
            ratio: Math.max(contrast(dark, bg), contrast(light, bg)),
            minimum: 3,
          });
          if (mark.textContent === "!") check(`${name} check symbol`, markStyle.color, dark, 4.5);
        }
        if (markStyle.backgroundImage.includes("linear-gradient")) {
          const ink = /rgb\([^)]+\)/.exec(markStyle.backgroundImage)![0];
          const keyline = /rgb\([^)]+\)/.exec(markStyle.filter)![0];
          check(`${name} last-move keylines`, ink, keyline);
          result.push({
            name: `${name} last move against square`,
            ratio: Math.max(contrast(ink, bg), contrast(keyline, bg)),
            minimum: 3,
          });
        }
      }
    }
    for (const graphic of document.querySelectorAll(
      'svg[role="img"] :is(line, polyline, circle, text)',
    )) {
      const style = getComputedStyle(graphic);
      const text = graphic.tagName === "text";
      check(
        `chart ${graphic.tagName}`,
        text || graphic.tagName === "circle" ? style.fill : style.stroke,
        background(graphic),
        text ? 4.5 : 3,
      );
    }
    for (const control of document.querySelectorAll<HTMLElement>(
      "button:not([data-square]), input, select, summary",
    )) {
      if (!control.checkVisibility() || control.closest('[aria-hidden="true"]')) continue;
      const style = getComputedStyle(control);
      const bg = background(control);
      // Disabled controls are exempt in WCAG, but the product promises readable labels.
      check(
        `${control.tagName} ${control.getAttribute("aria-disabled") === "true" ? "disabled" : "enabled"} text`,
        style.color,
        bg,
        4.5,
      );
      if (control.matches(":focus-visible")) {
        check(`${control.tagName} focus`, style.outlineColor, background(control.parentElement!));
      }
    }
    return result;
  });
  expect(checks.length).toBeGreaterThan(0);
  expect(checks.filter(({ ratio, minimum }) => !Number.isFinite(ratio) || ratio < minimum)).toEqual(
    [],
  );
  return checks;
}
