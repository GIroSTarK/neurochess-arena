import AxeBuilder from "@axe-core/playwright";

import { createAccount } from "./account-helpers";
import { API_ORIGIN, DISABLED_WEB_ORIGIN, WEB_ORIGIN } from "./environment";
import { activate, expect, playMove, readSnapshot, startSandbox, test } from "./fixtures";

for (const source of ["/", "/sandbox"]) {
  test(`leaving ${source} never briefly announces stopped game controls`, async ({ page }) => {
    await page.goto(source);
    await expect(
      source === "/"
        ? page.getByRole("heading", { name: "Set up a game", exact: true })
        : page.getByRole("button", { name: "Start sandbox", exact: true }),
    ).toBeVisible();
    const notices = await page.evaluateHandle(() => {
      const observed: string[] = [];
      new MutationObserver((records) => {
        for (const record of records) {
          const nodes = record.type === "characterData" ? [record.target] : record.addedNodes;
          for (const node of nodes) {
            if (node.textContent?.includes("Game controls stopped")) {
              observed.push(node.textContent);
            }
          }
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
      return observed;
    });
    await page.getByRole("link", { name: "History", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Private game history" })).toBeVisible();
    expect(await notices.jsonValue()).toEqual([]);
    await notices.dispose();
  });
}

test("Arena checks unfinished games without bootstrapping and links to Sandbox on desktop and mobile", async ({
  page,
}, testInfo) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(API_ORIGIN)) apiRequests.push(new URL(request.url()).pathname);
  });
  const unfinishedRequest = page.waitForRequest(API_ORIGIN + "/games/unfinished");
  await page.goto("/");
  await unfinishedRequest;
  await expect(page).toHaveTitle("Neurochess Arena");
  await expect(page.getByRole("heading", { name: "Set up a game", exact: true })).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  const arena = navigation.getByRole("link", { name: "Arena", exact: true });
  const sandbox = navigation.getByRole("link", { name: "Sandbox", exact: true });
  await expect(arena).toHaveAttribute("aria-current", "page");
  await expect(sandbox).toBeVisible();
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const box = await sandbox.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  }
  await page.setViewportSize(testInfo.project.use.viewport!);
  await page.screenshot({ path: testInfo.outputPath("arena.png"), fullPage: true });
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
      .violations,
  ).toEqual([]);
  expect(apiRequests).toContain("/games/unfinished");
  expect(
    apiRequests.every((path) => ["/games/unfinished", "/api/auth/get-session"].includes(path)),
  ).toBe(true);
  await sandbox.focus();
  await page.evaluate(() => {
    Object.assign(window, { navigationSentinel: "same-document" });
  });
  await expect(sandbox).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/sandbox$/);
  await expect(page.getByRole("heading", { name: "Sandbox", exact: true })).toBeVisible();
  await expect(sandbox).toHaveAttribute("aria-current", "page");
  await expect(arena).not.toHaveAttribute("aria-current");
  await page.screenshot({ path: testInfo.outputPath("sandbox-navigation.png"), fullPage: true });
  await page.goBack();
  await expect(page).toHaveTitle("Neurochess Arena");
  await expect(arena).toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => Reflect.get(window, "navigationSentinel") as unknown)).toBe(
    "same-document",
  );
  await page.goForward();
  await expect(page).toHaveURL(/\/sandbox$/);
  await expect(sandbox).toHaveAttribute("aria-current", "page");
  expect(await page.evaluate(() => Reflect.get(window, "navigationSentinel") as unknown)).toBe(
    "same-document",
  );
  await activate(sandbox, testInfo.project.name === "mobile-touch");
  await expect(page.getByRole("button", { name: "Start sandbox", exact: true })).toBeVisible();
  await activate(arena, testInfo.project.name === "mobile-touch");
  await expect(page).toHaveTitle("Neurochess Arena");
});

test("a disabled Sandbox is absent from navigation and direct links make no API requests", async ({
  page,
}, testInfo) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(API_ORIGIN)) apiRequests.push(new URL(request.url()).pathname);
  });
  await page.route("**/games/unfinished", (route) => route.fulfill({ json: { game: null } }));
  await page.route("**/api/auth/get-session", (route) => route.fulfill({ json: null }));
  await page.goto(DISABLED_WEB_ORIGIN);
  await expect(page).toHaveTitle("Neurochess Arena");
  await expect(page.getByRole("heading", { name: "Set up a game", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link")).toHaveText(["Arena", "History"]);
  await expect(page.getByRole("link", { name: "Sandbox", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open development sandbox" })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("arena-sandbox-disabled.png"),
    fullPage: true,
  });
  apiRequests.length = 0;
  for (const path of ["/sandbox", "/sandbox/", "/sandbox/games/invalid"]) {
    await page.goto(DISABLED_WEB_ORIGIN + path);
    await expect(page).toHaveTitle("Page unavailable · Neurochess Arena");
    await expect(page.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sandbox", exact: true })).toHaveCount(0);
    await expect(page.getByRole("grid")).toHaveCount(0);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  }
  await page.screenshot({ path: testInfo.outputPath("sandbox-unavailable.png"), fullPage: true });
  expect(apiRequests).toEqual([]);
  await activate(
    page.getByRole("link", { name: "Back to Arena" }),
    testInfo.project.name === "mobile-touch",
  );
  await expect(page).toHaveTitle("Neurochess Arena");
});

test("Sandbox loads on demand and keeps navigation visible while its module is pending", async ({
  page,
}, testInfo) => {
  const loading = Promise.withResolvers<void>();
  let sandboxRequested = false;
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(API_ORIGIN)) apiRequests.push(new URL(request.url()).pathname);
  });
  await page.route("**/src/sandbox/SandboxRoute.tsx", async (route) => {
    sandboxRequested = true;
    await loading.promise;
    await route.continue();
  });

  const unfinishedRequest = page.waitForRequest(API_ORIGIN + "/games/unfinished");
  await page.goto("/");
  await unfinishedRequest;
  await expect(page.getByRole("heading", { name: "Set up a game", exact: true })).toBeVisible();
  expect(sandboxRequested).toBe(false);
  await page.getByRole("link", { name: "Sandbox", exact: true }).click();
  await expect(page.getByText("Opening page…", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Loading page…", exact: true })).toBeVisible();
  await expect(page.getByText("Checking your session", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Arena", exact: true })).toBeVisible();
  await expect(page.getByRole("grid")).toHaveCount(0);
  await expect.poll(() => sandboxRequested).toBe(true);
  expect(apiRequests).toContain("/games/unfinished");
  expect(
    apiRequests.every((path) => ["/games/unfinished", "/api/auth/get-session"].includes(path)),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("sandbox-loading.png"), fullPage: true });

  loading.resolve();
  await expect(page).toHaveURL(/\/sandbox$/);
  await expect(page).toHaveTitle("Development sandbox · Neurochess Arena");
  await expect(page.getByRole("grid", { name: "Chessboard" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start sandbox", exact: true })).toBeVisible();
  await expect(page.getByText("Opening page…")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Sandbox", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("Arena resolves a Sandbox game URL and links to its authorized recovery", async ({
  page,
}, testInfo) => {
  const touch = testInfo.project.name === "mobile-touch";
  let current = await startSandbox(page, touch);
  current = await playMove(page, current, "e2e4", touch);
  const gameUrl = page.url();
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(API_ORIGIN)) apiRequests.push(new URL(request.url()).pathname);
  });
  await page.goto("/games/" + current.gameId);
  const recoveryLink = page.getByRole("link", { name: "Return to Sandbox" });
  await expect(recoveryLink).toBeVisible();
  await expect(recoveryLink).toHaveAttribute("href", `/sandbox/games/${current.gameId}`);
  expect(new URL(page.url()).pathname).toBe("/games/" + current.gameId);
  await expect(page.getByRole("grid")).toHaveCount(0);
  expect(apiRequests.length).toBeGreaterThan(0);
  expect(
    apiRequests.every((path) =>
      [`/games/${current.gameId}/details`, "/api/auth/get-session"].includes(path),
    ),
  ).toBe(true);
  await page.goto(gameUrl);
  await expect(page).toHaveURL(new RegExp("/sandbox/games/" + current.gameId + "$"));
  await expect(page.getByRole("heading", { name: /^Game paused ·/ })).toBeVisible();
  await expect(page.getByRole("grid")).toHaveAttribute("data-fen", current.fen);
  expect(await readSnapshot(page, current.gameId)).toEqual({
    ...current,
    state: "paused",
    version: current.version + 1,
    legalMoves: [],
  });
});

test("obsolete and mixed game links stay unavailable without discovery or redirects", async ({
  page,
}) => {
  const gameId = "00000000-0000-4000-8000-000000000001";
  const calls: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(API_ORIGIN)) calls.push(new URL(request.url()).pathname);
  });
  for (const path of [
    "/?game=" + gameId,
    "/?game=",
    "/?game=" + gameId + "&game=",
    "/sandbox?game=" + gameId,
    "/sandbox?game=",
    "/sandbox?game=" + gameId + "&game=",
    "/games/" + gameId + "?game=" + gameId,
    "/sandbox/games/" + gameId + "?game=",
    "/games/invalid",
    "/games/" + gameId + "/extra",
    "/games/" + gameId + "%2Fextra",
    "/GAMES/" + gameId,
    "/sandbox/games/" + gameId + "/extra",
    "/sandbox/games/" + gameId + "%2Fextra",
    "/Sandbox/games/" + gameId,
    "/unknown-route",
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(path);
  }
  expect(calls).toEqual([]);
});

test("canonical game links open an authorized new tab without navigating the source", async ({
  page,
  context,
}, testInfo) => {
  const current = await startSandbox(page, testInfo.project.name === "mobile-touch");
  await page.goto("/games/" + current.gameId);
  const link = page.getByRole("link", { name: "Return to Sandbox" });
  await expect(link).toHaveAttribute("href", "/sandbox/games/" + current.gameId);
  await page.evaluate(() => Object.assign(window, { navigationSentinel: "source-document" }));
  const destination = await link.getAttribute("href");
  const other =
    testInfo.project.name === "desktop"
      ? await Promise.all([
          context.waitForEvent("page"),
          link.click({ modifiers: ["Control"] }),
        ]).then(([tab]) => tab)
      : await context.newPage();
  try {
    if (testInfo.project.name !== "desktop") await other.goto(destination!);
    await expect(other).toHaveURL(WEB_ORIGIN + "/sandbox/games/" + current.gameId);
    await expect(other.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    await expect(other.getByRole("main")).toHaveCount(1);
    await other.reload();
    await expect(other.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    await expect(page).toHaveURL(WEB_ORIGIN + "/games/" + current.gameId);
    expect(await page.evaluate(() => Reflect.get(window, "navigationSentinel") as unknown)).toBe(
      "source-document",
    );
  } finally {
    await other.close();
  }
});

test("keyboard route changes and native skip links focus a single main with reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/auth/sign-in");
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  const history = page.getByRole("link", { name: "History", exact: true });
  await history.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Private game history" })).toBeVisible();
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Private game history" })).toBeFocused();
  await expect(history).toHaveAttribute("aria-current", "page");
  const skip = page.getByRole("link", { name: /Skip to/ });
  await skip.focus();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  expect(new URL(page.url()).hash).toBe("#account-main");
});

test("a failed lazy module has safe navigation and an explicit reload recovery", async ({
  page,
  expectedModuleFailures,
  expectedRouteErrors,
}) => {
  const moduleUrl = WEB_ORIGIN + "/src/sandbox/SandboxRoute.tsx";
  expectedModuleFailures.set(page, new Set([moduleUrl]));
  expectedRouteErrors.set(page, new Set(["Route error ROUTE_MODULE_UNAVAILABLE"]));
  await page.route(moduleUrl, (route) => route.abort("failed"), { times: 1 });
  await page.goto("/sandbox");
  await expect(page.getByRole("heading", { name: "This page could not be loaded." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Arena", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reload page" }).click();
  await expect(page.getByRole("button", { name: "Start sandbox", exact: true })).toBeVisible();
});

for (const pending of [false, true]) {
  test(`native skip links retain profile saves (pending: ${String(pending)})`, async ({ page }) => {
    const { username } = await createAccount(page.request);
    const saving = Promise.withResolvers<void>();
    await page.route(API_ORIGIN + "/profile", async (route) => {
      if (route.request().method() === "POST" && pending) await saving.promise;
      await route.continue();
    });
    await page.goto("/history");
    await page.getByRole("link", { name: username, exact: true }).click();
    const request = page.waitForRequest(
      (request) => request.url() === API_ORIGIN + "/profile" && request.method() === "POST",
    );
    await page.getByRole("button", { name: "Save profile" }).click();
    await request;
    if (!pending) await expect(page.getByText("Profile saved.", { exact: true })).toBeVisible();
    try {
      await page.getByRole("link", { name: "Skip to main content" }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("main")).toBeFocused();
      if (pending) {
        await expect(page.getByRole("button", { name: "Save profile" })).toHaveAttribute(
          "aria-disabled",
          "true",
        );
      }
      saving.resolve();
      await expect(page.getByText("Profile saved.", { exact: true })).toBeVisible();
    } finally {
      saving.resolve();
    }
  });
}

test("Back restores history scroll after its delayed private read finishes", async ({ page }) => {
  await createAccount(page.request);
  const history = {
    games: Array.from({ length: 20 }, (_, index) => ({
      gameId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      finishedAt: "2026-10-01T12:00:00.123456Z",
      configuration: {
        mode: "ai_vs_ai",
        seats: {
          white: { type: "ai", provider: "openai", modelId: "fixture/model-a", parameters: {} },
          black: { type: "ai", provider: "openai", modelId: "fixture/model-a", parameters: {} },
        },
      },
      state: "aborted",
      result: "*",
      terminationReason: "aborted",
    })),
    nextCursor: null,
  };
  const release = Promise.withResolvers<void>();
  let reads = 0;
  await page.route(API_ORIGIN + "/games/history?limit=20", async (route) => {
    if (++reads > 1) await release.promise;
    await route.fulfill({ json: history });
  });
  await page.goto("/history");
  await expect(
    page.getByRole("list", { name: "Finished games" }).getByRole("listitem"),
  ).toHaveCount(20);
  expect(
    await page.getByRole("link", { name: "Arena", exact: true }).evaluate(
      (link: HTMLAnchorElement) =>
        new Promise<number>((resolve) => {
          requestAnimationFrame(() => {
            // Navigate before the browser delivers the scroll event that caches this position.
            window.scrollTo({ top: 600, behavior: "instant" });
            const top = window.scrollY;
            link.click();
            resolve(top);
          });
        }),
    ),
  ).toBe(600);
  await expect(page.getByRole("heading", { name: "Set up a game" })).toBeVisible();
  await page.goBack();
  await expect.poll(() => reads).toBe(2);
  await expect(page.getByText("Opening page…", { exact: true })).toBeVisible();
  await expect(page.getByRole("list", { name: "Finished games" })).toHaveCount(0);
  release.resolve();
  await expect(
    page.getByRole("list", { name: "Finished games" }).getByRole("listitem"),
  ).toHaveCount(20);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(600);
});
