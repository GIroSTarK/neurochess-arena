import AxeBuilder from "@axe-core/playwright";
import { gameDetailsSchema } from "@neurochess/contracts";
import type { Page } from "@playwright/test";

import { API_ORIGIN, DISABLED_WEB_ORIGIN } from "./environment";
import { expect, startSandbox, test } from "./fixtures";
import { expectUnbrokenWords, setPseudoLocalization } from "./text-layout";

async function configure(page: Page, color: "White" | "Black", search = "model-a") {
  const seat = page.getByRole("group", { name: color, exact: true });
  await expect(seat.getByLabel("Provider", { exact: true })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await seat.getByLabel("Provider", { exact: true }).selectOption("openai");
  await seat.getByLabel("API key", { exact: true }).fill(`${color}-fixture-sentinel`);
  await seat.getByRole("button", { name: "Load models", exact: true }).click();
  await expect(seat.getByText("Models loaded. Choose a model to continue.")).toBeVisible();
  const model = seat.getByRole("combobox", { name: "Model", exact: true });
  await model.focus();
  await model.fill(search);
  await model.press("ArrowDown");
  await model.press("Enter");
  await expect(model).toBeFocused();
  await expect(model).toHaveValue(
    search === "model-a" ? "Model A (test fixture)" : /Long test model/,
  );
  return seat;
}

test("setup uses protected discovery and hands off an independently configured game", async ({
  page,
  context,
}, testInfo) => {
  const posts: { url: string; body: string | null }[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(API_ORIGIN) && request.method() === "POST") {
      posts.push({ url: request.url(), body: request.postData() });
    }
  });
  await page.goto("/__test__/setup");
  await expect(page.getByRole("button", { name: "Start game" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(posts).toEqual([]);
  expect(await context.cookies(API_ORIGIN)).toEqual([]);
  const white = await configure(page, "White");
  const black = await configure(page, "Black");
  await white.getByText("Advanced parameters", { exact: true }).click();
  await white.getByLabel("Temperature", { exact: true }).fill("1e");
  await white.getByLabel("Temperature", { exact: true }).press("Tab");
  await expect(white.getByLabel("Temperature", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.getByRole("button", { name: "Start game" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await white.getByLabel("Temperature", { exact: true }).fill("0.4");
  await black.getByText("Advanced parameters", { exact: true }).click();
  await black.getByLabel("Maximum output tokens", { exact: true }).fill("512");
  await black.getByLabel("Maximum output tokens", { exact: true }).press("Tab");
  await expect(page.getByRole("button", { name: "Start game" })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  expect((await new AxeBuilder({ page }).include("#arena-setup").analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("setup-ready.png"), fullPage: true });
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: localStorage,
        session: sessionStorage,
        name: window.name,
        cookie: document.cookie,
      }),
    ),
  ).not.toContain("fixture-sentinel");
  const created = page.waitForResponse(
    (response) => response.url() === API_ORIGIN + "/games" && response.status() === 201,
  );
  await page.getByRole("button", { name: "Start game" }).click();
  const game = gameDetailsSchema.parse(await (await created).json());
  await expect(page.getByRole("status")).toContainText("Handoff received");
  expect(game.configuration?.seats).toMatchObject({
    white: { provider: "openai", modelId: "fixture/model-a", parameters: { temperature: 0.4 } },
    black: { provider: "openai", modelId: "fixture/model-a", parameters: { maxOutputTokens: 512 } },
  });
  expect(
    posts
      .filter((post) => !post.url.endsWith("/providers/models"))
      .some((post) => post.body?.includes("fixture-sentinel")),
  ).toBe(false);
  expect(
    posts.some((post) => post.url.includes("fixture-sentinel") || post.url.endsWith("/ai-turn")),
  ).toBe(false);
  await page.reload();
  await expect(page.getByRole("button", { name: "Return to game" })).toBeVisible();
  for (const color of ["White", "Black"]) {
    await expect(
      page.getByRole("group", { name: color, exact: true }).getByLabel("API key", { exact: true }),
    ).toHaveValue("");
  }
});

test("setup keeps key rejection and empty discovery recoverable and clears page-memory fields", async ({
  page,
}) => {
  await page.goto("/__test__/setup");
  const white = page.getByRole("group", { name: "White", exact: true });
  await expect(white.getByLabel("Provider", { exact: true })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await white.getByLabel("API key", { exact: true }).fill("rejected-fixture");
  await white.getByRole("button", { name: "Load models", exact: true }).click();
  await expect(white.getByText("This key was rejected. Update it and retry.")).toBeVisible();
  await expect(white.getByLabel("API key", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await white.getByLabel("API key", { exact: true }).fill("empty-fixture");
  await white.getByRole("button", { name: "Load models", exact: true }).click();
  await expect(white.getByText(/No models are available/)).toBeVisible();
  await configure(page, "Black");
  await white.getByLabel("Provider", { exact: true }).selectOption("google");
  await expect(white.getByLabel("API key", { exact: true })).toHaveValue("");
  await page.reload();
  await expect(
    page.getByRole("group", { name: "Black", exact: true }).getByLabel("API key", { exact: true }),
  ).toHaveValue("");
  await expect(page.getByRole("button", { name: "Start game" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});

test("setup handles an existing Sandbox while public and disabled entry points stay unchanged", async ({
  page,
}) => {
  const game = await startSandbox(page, false);
  await page.goto("/__test__/setup");
  await page.getByRole("button", { name: "Return to game" }).click();
  await expect(page.getByRole("status")).toContainText(game.gameId);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Watch models make their moves." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start game" })).toHaveCount(0);
  await page.goto(DISABLED_WEB_ORIGIN + "/__test__/setup");
  await expect(page.getByRole("heading", { name: "Page unavailable" })).toBeVisible();
});

test("setup reflows at all reference widths with expanded text, long names and visible keyboard focus", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.goto("/__test__/setup");
  const white = await configure(page, "White", "fixture/long");
  const black = await configure(page, "Black", "fixture/long");
  await white.getByText("Advanced parameters", { exact: true }).click();
  await black.getByText("Advanced parameters", { exact: true }).click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const expanded of [false, true]) {
      await setPseudoLocalization(page, expanded);
      await page.evaluate((large) => {
        document.documentElement.style.fontSize = large ? "200%" : "100%";
      }, expanded);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
        .toBeLessThanOrEqual(1);
      await expectUnbrokenWords(page.locator("button, summary, legend"));
      const start = page.getByRole("button", { name: /^Start game/ });
      await start.focus();
      await start.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(start).toBeFocused();
      await expect(start).toBeInViewport();
      expect(await start.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
        "none",
      );
      const whiteBox = await page.getByRole("group", { name: /^White/ }).boundingBox();
      const blackBox = await page.getByRole("group", { name: /^Black/ }).boundingBox();
      expect(whiteBox && blackBox && Math.abs(whiteBox.width - blackBox.width)).toBeLessThanOrEqual(
        1,
      );
    }
  }
  await setPseudoLocalization(page, false);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "100%";
  });
  await page.setViewportSize(
    testInfo.project.name === "desktop"
      ? { width: 1440, height: 1080 }
      : { width: 390, height: 844 },
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("setup-layout.png"), fullPage: true });
});
