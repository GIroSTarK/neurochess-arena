import type { Locator } from "@playwright/test";

import { expect } from "./fixtures";

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
