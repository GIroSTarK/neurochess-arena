import type { Locator, Page } from "@playwright/test";

import { expect } from "./fixtures";

export async function expectClipboardCopy(
  page: Page,
  button: Locator,
  expected: string,
  browserName: string,
  touch = false,
) {
  if (browserName !== "firefox") {
    await page
      .context()
      .grantPermissions(
        browserName === "chromium" ? ["clipboard-read", "clipboard-write"] : ["clipboard-read"],
        { origin: new URL(page.url()).origin },
      );
  }
  // Firefox cannot grant clipboard-read. Observe the argument only after the native write
  // succeeds, retaining the browser's activation/security checks on every engine.
  await page.evaluate(() => {
    const nativeWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    Object.assign(window, { acceptedClipboardWrite: null });
    navigator.clipboard.writeText = async (text) => {
      await nativeWrite(text);
      Object.assign(window, { acceptedClipboardWrite: text });
    };
  });
  if (touch) await button.tap();
  else await button.click();
  await expect
    .poll(() =>
      page.evaluate((wanted) => Reflect.get(window, "acceptedClipboardWrite") === wanted, expected),
    )
    .toBe(true);
  if (browserName !== "firefox") {
    // Native Windows clipboard readback may normalize line endings.
    // Keep invitation tokens and unrelated OS clipboard contents out of assertion reports.
    expect(
      await page.evaluate(
        async (wanted) =>
          (await navigator.clipboard.readText()).replaceAll("\r\n", "\n") === wanted,
        expected,
      ),
    ).toBe(true);
  }
}
