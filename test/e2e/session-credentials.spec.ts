import type * as CredentialsModule from "../../apps/web/src/api/session-credentials";

import { API_ORIGIN } from "./environment";
import { expect, test } from "./fixtures";

test("AI credentials stay in page memory and require re-entry after refresh", async ({
  page,
  context,
}) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(API_ORIGIN)) apiRequests.push(request.url());
  });
  await page.goto("/");
  const sentinel = "browser-session-only-sentinel";
  const result = await page.evaluate(async (key) => {
    const modulePath = "/src/api/session-credentials.ts";
    const { createSessionCredentials } = (await import(modulePath)) as typeof CredentialsModule;
    const credentials = createSessionCredentials(new AbortController().signal);
    credentials.set("white", "openai", key);
    Reflect.set(window, "p2CredentialFixture", credentials);
    return {
      usable: credentials.require("white", "openai") === key,
      persisted: JSON.stringify({
        local: localStorage,
        session: sessionStorage,
        cookie: document.cookie,
        name: window.name,
      }),
      serializable: JSON.stringify(credentials),
    };
  }, sentinel);
  expect(result.usable).toBe(true);
  expect(result.persisted).not.toContain(sentinel);
  expect(result.serializable).not.toContain(sentinel);
  await page.reload();
  expect(await page.evaluate(() => Reflect.has(window, "p2CredentialFixture"))).toBe(false);
  const restored = await page.evaluate(async () => {
    const modulePath = "/src/api/session-credentials.ts";
    const { createSessionCredentials } = (await import(modulePath)) as typeof CredentialsModule;
    const credentials = createSessionCredentials(new AbortController().signal);
    try {
      credentials.require("white", "openai");
      return "unexpected-key";
    } catch (error: unknown) {
      return error instanceof Error ? error.message : "unexpected-error";
    } finally {
      credentials.dispose();
    }
  });
  expect(restored).toBe("AI_KEY_REQUIRED");
  expect(apiRequests).toEqual([]);
  expect(await context.cookies(API_ORIGIN)).toEqual([]);
});
