import type { Locator, Page } from "@playwright/test";

import type * as webI18n from "../../apps/web/src/i18n";

import { expect } from "./fixtures";

export async function setPseudoLocalization(page: Page, enabled: boolean) {
  // Inject expanded resources through the dev module to keep test locales out of the app bundle.
  await page.evaluate(async (enabled) => {
    const modulePath = "/src/i18n/index.ts";
    const { i18n } = (await import(/* @vite-ignore */ modulePath)) as typeof webI18n;
    if (enabled) {
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
    }
    await i18n.changeLanguage(enabled ? "en-XA" : "en");
  }, enabled);
}

export async function expectUnbrokenWords(locator: Locator) {
  const broken = await locator.evaluateAll((elements) =>
    elements.flatMap((element) => {
      const words: { word: string; lines: number; availableWidth: number; fontSize: string }[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        if (
          !parent?.checkVisibility({ visibilityProperty: true }) ||
          parent.closest('[aria-hidden="true"]')
        ) {
          continue;
        }
        for (const match of (node.textContent ?? "").matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const lines = new Set(
            [...range.getClientRects()]
              .filter((rect) => rect.width > 0)
              .map((rect) => Math.round(rect.top)),
          ).size;
          if (lines > 1) {
            words.push({
              word: match[0],
              lines,
              availableWidth: parent.getBoundingClientRect().width,
              fontSize: getComputedStyle(parent).fontSize,
            });
          }
        }
      }
      return words;
    }),
  );
  expect(broken, "Control labels and human seat labels must wrap between words").toEqual([]);
}
