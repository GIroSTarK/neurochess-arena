import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, test } from "./fixtures";

test("a context has its own test-client identity before opening a page", async ({ context }) => {
  expect(context.pages()).toHaveLength(0);
  const client = (await context.cookies(API_ORIGIN)).find(
    (cookie) => cookie.name === "neurochess_test_client",
  );
  expect(client?.value ?? "").toMatch(/^[a-f0-9-]{36}$/);
});

test("extra contexts keep explicit options and isolate client identities even with copied storage", async ({
  context,
  newContext,
}) => {
  await context.addCookies([
    { name: "context-fixture-state", value: "fixture-only", url: WEB_ORIGIN },
  ]);
  const fresh = await newContext({
    baseURL: WEB_ORIGIN,
    viewport: { width: 720, height: 600 },
    isMobile: true,
    hasTouch: true,
  });
  const restored = await newContext({ storageState: await context.storageState() });
  const identities: string[] = [];
  for (const browserContext of [context, fresh, restored]) {
    const cookies = await browserContext.cookies(API_ORIGIN);
    const identity = cookies.find((cookie) => cookie.name === "neurochess_test_client")?.value;
    expect(identity ?? "").toMatch(/^[a-f0-9-]{36}$/);
    identities.push(identity!);
    expect(cookies.some((cookie) => cookie.name === "context-fixture-state")).toBe(
      browserContext !== fresh,
    );
  }
  expect(new Set(identities).size).toBe(3);
  const page = await fresh.newPage();
  await page.goto("/");
  expect(new URL(page.url()).origin).toBe(WEB_ORIGIN);
  expect(page.viewportSize()).toEqual({ width: 720, height: 600 });
  expect(await page.evaluate(() => navigator.maxTouchPoints > 0)).toBe(true);
});

test("console errors from a closed secondary page fail its owning test", async ({ page }) => {
  const secondary = await page.context().newPage();
  await secondary.evaluate(() => console.error("secondary-page-console-sentinel"));
  await secondary.close();
  // Only the diagnostics fixture's teardown should fail; setup must succeed first.
  test.fail(true, "The fixture must reject the secondary page's console error");
});

test("console warnings from an extra context fail its owning test", async ({ newContext }) => {
  const context = await newContext();
  const page = await context.newPage();
  await page.evaluate(() => console.warn("extra-context-console-sentinel"));
  await context.close();
  test.fail(true, "The fixture must reject the extra context's console warning");
});

test("uncaught errors from a secondary page fail its owning test", async ({ page }) => {
  const secondary = await page.context().newPage();
  const error = secondary.waitForEvent("pageerror");
  await secondary.evaluate(() => {
    setTimeout(() => {
      throw new Error("secondary-page-error-sentinel");
    }, 0);
  });
  await error;
  await secondary.close();
  test.fail(true, "The fixture must reject the secondary page's uncaught error");
});

test("expected HTTP errors are consumed on their specified page", async ({
  page,
  expectedGame404s,
}) => {
  const url = API_ORIGIN + "/games/fixture-unavailable/details";
  const expected = new Set([url]);
  expectedGame404s.set(page, expected);
  await page.route(url, (route) => route.fulfill({ status: 404, body: "Fixture unavailable" }));
  const error = page.waitForEvent("console", (message) => message.type() === "error");
  await page.goto(url);
  await error;
  expect(expected.size).toBe(0);
});

test("an HTTP allowance on one page cannot hide errors on another page", async ({
  page,
  allowedIdentity401s,
}) => {
  const url = API_ORIGIN + "/credentials";
  allowedIdentity401s.set(page, new Set([url]));
  const secondary = await page.context().newPage();
  await secondary.route(url, (route) => route.fulfill({ status: 401, body: "Fixture expired" }));
  const error = secondary.waitForEvent("console", (message) => message.type() === "error");
  await secondary.goto(url);
  await error;
  await secondary.close();
  test.fail(true, "The fixture must reject the other page's unallowed HTTP error");
});
