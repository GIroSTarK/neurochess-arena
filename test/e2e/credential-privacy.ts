import type { Page } from "@playwright/test";

import { expect } from "./fixtures";

export function observeCredentialPrivacy(page: Page, sentinels: readonly string[]) {
  let requestUrlContainsKey = false;
  page.on("request", (request) => {
    if (sentinels.some((key) => request.url().includes(key))) requestUrlContainsKey = true;
  });

  return async function expectPrivate() {
    // Return leak flags, never stored values or cookie contents, to assertion output.
    const exposed = await page.evaluate((keys) => {
      const containsKey = (value: string) => keys.some((key) => value.includes(key));
      return {
        local: containsKey(JSON.stringify(localStorage)),
        session: containsKey(JSON.stringify(sessionStorage)),
        cookie: containsKey(document.cookie),
        name: containsKey(window.name),
        url: containsKey(location.href),
        history: containsKey(JSON.stringify(history.state)),
      };
    }, sentinels);
    expect(exposed).toEqual({
      local: false,
      session: false,
      cookie: false,
      name: false,
      url: false,
      history: false,
    });
    const cookies = JSON.stringify(await page.context().cookies());
    expect(sentinels.some((key) => cookies.includes(key))).toBe(false);
    expect(requestUrlContainsKey).toBe(false);
  };
}
