import type { Page } from "@playwright/test";

import { expect } from "./fixtures";

export function observeCredentialPrivacy(page: Page, sentinels: readonly string[]) {
  let requestUrlContainsKey = false;
  let referrerContainsKey = false;
  let diagnosticContainsKey = false;
  const containsKey = (value: string) => sentinels.some((key) => value.includes(key));
  page.on("request", (request) => {
    if (containsKey(request.url())) requestUrlContainsKey = true;
    if (containsKey(request.headers().referer ?? "")) referrerContainsKey = true;
  });
  page.on("console", (message) => {
    if (containsKey(message.text())) diagnosticContainsKey = true;
  });
  page.on("pageerror", (error) => {
    if (containsKey(error.message)) diagnosticContainsKey = true;
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
        referrer: containsKey(document.referrer),
        rendered: containsKey(document.body.textContent),
      };
    }, sentinels);
    expect(exposed).toEqual({
      local: false,
      session: false,
      cookie: false,
      name: false,
      url: false,
      history: false,
      referrer: false,
      rendered: false,
    });
    const cookies = JSON.stringify(await page.context().cookies());
    expect(sentinels.some((key) => cookies.includes(key))).toBe(false);
    expect(requestUrlContainsKey).toBe(false);
    expect(referrerContainsKey).toBe(false);
    expect(diagnosticContainsKey).toBe(false);
  };
}
