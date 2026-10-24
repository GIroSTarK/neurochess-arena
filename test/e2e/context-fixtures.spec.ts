import { createAccount } from "./account-helpers";
import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, test } from "./fixtures";

test("a context has its own test-client identity before opening a page", async ({ context }) => {
  expect(context.pages()).toHaveLength(0);
  const client = (await context.cookies(API_ORIGIN)).find(
    (cookie) => cookie.name === "neurochess_test_client",
  );
  expect(client?.value ?? "").toMatch(/^[a-f0-9-]{36}$/);
});

test("secure session cookies authorize browser requests after reload", async ({
  page,
  context,
}) => {
  const account = await createAccount(page.request);
  const cookies = await context.cookies(API_ORIGIN);
  expect(
    cookies.some(
      (cookie) => cookie.name.includes("session_token") && cookie.secure && cookie.httpOnly,
    ),
  ).toBe(true);
  await page.goto("/account");
  await expect(page.getByLabel("Username", { exact: true })).toHaveValue(account.username);
  await page.reload();
  await expect(page.getByLabel("Username", { exact: true })).toHaveValue(account.username);
  expect(await page.evaluate(() => document.cookie.includes("session_token"))).toBe(false);
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
  await page.evaluate(() => {
    document.body.addEventListener("touchstart", () => (document.body.dataset.touched = "true"));
  });
  await page.getByRole("heading").first().tap();
  await expect(page.locator("body")).toHaveAttribute("data-touched", "true");
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

test("a declared native warning is allowed on its own page", async ({
  page,
  allowedNativeWarnings,
}) => {
  allowedNativeWarnings.set(page, [/^native-warning-fixture$/]);
  await page.evaluate(() => console.warn("native-warning-fixture"));
});

test("a native warning allowance cannot hide another page's warning", async ({
  page,
  allowedNativeWarnings,
}) => {
  allowedNativeWarnings.set(page, [/^native-warning-fixture$/]);
  const secondary = await page.context().newPage();
  await secondary.evaluate(() => console.warn("native-warning-fixture"));
  await secondary.close();
  test.fail(true, "The fixture must reject the warning from the other page");
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

test("unhandled rejections fail their owning test", async ({ page }) => {
  const error = page.waitForEvent("pageerror");
  await page.evaluate(() => {
    setTimeout(() => void Promise.reject(new Error("rejection-sentinel")), 0);
  });
  await error;
  test.fail(true, "The fixture must reject the unhandled promise");
});

for (const failure of ["rejection", "exception"] as const) {
  test(`an unhandled worker ${failure} fails its owning test`, async ({ page }) => {
    await page.goto("/");
    // Engines surface worker failures through different channels; wait on the worker itself.
    await page.evaluate(
      async (source) => {
        const worker = new Worker(
          URL.createObjectURL(new Blob([source], { type: "text/javascript" })),
        );
        Reflect.set(window, "fixtureWorker", worker);
        await new Promise((resolve) => worker.addEventListener("message", resolve, { once: true }));
      },
      `setTimeout(() => { ${failure === "rejection" ? "void Promise.reject(new Error('worker-sentinel'))" : "throw new Error('worker-sentinel')"}; }, 0);
setTimeout(() => postMessage("settled"), 100);`,
    );
    await page.evaluate(() => new Promise(requestAnimationFrame));
    test.fail(true, "The fixture must reject the worker's uncaught failure");
  });
}

test("a live engine loading failure still fails its owning test", async ({
  page,
  context,
  browserName,
}) => {
  await context.route("**/stockfish-19-lite-single.wasm", (route) => route.abort());
  await page.goto("/");
  // Chromium reports a WebError; Firefox's native fetch error has no worker association.
  const failure =
    browserName === "chromium"
      ? context.waitForEvent("weberror")
      : page.waitForEvent(
          "console",
          (message) =>
            message.type() === "error" &&
            (message.worker() !== null ||
              (browserName === "firefox" &&
                message.text().includes("NetworkError when attempting to fetch resource."))),
        );
  await page.evaluate((url) => {
    const worker = new Worker(url);
    Reflect.set(window, "fixtureEngine", worker);
    worker.postMessage("uci");
  }, WEB_ORIGIN + "/engines/sf19-lite-single-v2/stockfish-19-lite-single.js");
  await failure;
  await page.evaluate(() => (Reflect.get(window, "fixtureEngine") as Worker).terminate());
  test.fail(true, "Only obsolete worker loads after navigation may be ignored");
});

test("unexpected room socket failures are not treated as intentional cancellation", async ({
  page,
}) => {
  const socket = API_ORIGIN.replace(/^http/, "ws") + "/rooms/realtime";
  await page.evaluate(
    (url) =>
      console.error(`WebSocket connection to '${url}' failed: Unexpected response code: 403`),
    socket,
  );
  test.fail(true, "Only the exact connecting-socket cancellation is allowed");
});

test("expected HTTP errors are consumed on their specified page", async ({
  page,
  expectedGame404s,
}) => {
  const url = API_ORIGIN + "/games/fixture-unavailable/details";
  const expected = new Set([url]);
  expectedGame404s.set(page, expected);
  await page.route(url, (route) => route.fulfill({ status: 404, body: "Fixture unavailable" }));
  expect((await page.goto(url))?.status()).toBe(404);
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
  expect((await secondary.goto(url))?.status()).toBe(401);
  await secondary.close();
  test.fail(true, "The fixture must reject the other page's unallowed HTTP error");
});
