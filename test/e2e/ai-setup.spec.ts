import { tmpdir } from "node:os";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { createAiGameRequestSchema, gameSnapshotSchema } from "@neurochess/contracts";
import { games, guestSessions } from "@neurochess/database";
import type { Page } from "@playwright/test";
import { eq, sql } from "drizzle-orm";

import type * as webI18n from "../../apps/web/src/i18n";
import { integrationDatabase } from "../database";

import { API_ORIGIN } from "./environment";
import { allowUnauthorizedResponse, expect, test } from "./fixtures";

async function openSetup(page: Page) {
  await page.goto("/");
  await expect(page).toHaveTitle("Set up a match · Neurochess Arena");
  await expect(page.getByRole("heading", { name: "Choose your contenders." })).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await expect(
    page.getByText("Opening your guest session and checking available providers…"),
  ).toHaveCount(0);
}

async function configure(
  page: Page,
  color: "White" | "Black",
  provider = "openai",
  key = `fixture-${color}-key`,
  modelName = "Fixture full",
) {
  const panel = page.getByRole("region", { name: `${color} configuration` });
  await panel.getByRole("combobox", { name: "Provider" }).selectOption(provider);
  await panel.getByLabel("API key", { exact: true }).fill(key);
  await panel.getByRole("button", { name: "Load models" }).click();
  await expect(panel.getByText("Checking models available to this key…")).toBeVisible();
  const picker = panel.getByRole("combobox", { name: "Model", exact: true });
  await picker.fill(modelName);
  await picker.press("ArrowDown");
  await picker.press("Enter");
  await expect(panel.getByText("Configuration ready", { exact: true })).toBeVisible();
  return panel;
}

for (const name of ["Temperature", "Maximum output tokens"] as const) {
  test(`resets transient ${name} validity on mode changes and discovery without discarding numeric values`, async ({
    page,
  }) => {
    await openSetup(page);
    await configure(page, "White");
    await configure(page, "Black");
    const white = page.getByRole("region", { name: "White configuration" });
    const start = page.getByRole("button", { name: "Start game" });
    const number = white.getByRole("spinbutton", { name });
    await white.getByText("Advanced parameters").click();
    await number.press("e");
    await number.press("Tab");
    await expect(number).toHaveAttribute("aria-invalid", "true");
    await expect(start).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("radio", { name: /AI vs human/ }).check();
    await page.getByRole("radio", { name: /AI vs AI/ }).check();
    await white.getByText("Advanced parameters").click();
    await expect(number).toHaveValue("");
    expect(await number.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(true);
    await expect(number).toHaveAttribute("aria-invalid", "false");
    await expect(start).toHaveAttribute("aria-disabled", "false");

    await number.press("e");
    await number.press("Tab");
    await expect(start).toHaveAttribute("aria-disabled", "true");
    await white.getByRole("button", { name: "Load models" }).click();
    await expect(white.getByRole("combobox", { name: "Model", exact: true })).toHaveValue(
      "Fixture full",
    );
    await white.getByText("Advanced parameters").click();
    await expect(number).toHaveValue("");
    await expect(number).toHaveAttribute("aria-invalid", "false");
    await expect(start).toHaveAttribute("aria-disabled", "false");

    const outOfRange = name === "Temperature" ? "3" : "2048";
    await number.fill(outOfRange);
    await page.getByRole("radio", { name: /AI vs human/ }).check();
    await page.getByRole("radio", { name: /AI vs AI/ }).check();
    await white.getByText("Advanced parameters").click();
    await expect(number).toHaveValue(outOfRange);
    await expect(start).toHaveAttribute("aria-disabled", "true");
    await white.getByRole("button", { name: "Load models" }).click();
    await expect(white.getByRole("combobox", { name: "Model", exact: true })).toHaveValue(
      "Fixture full",
    );
    await white.getByText("Advanced parameters").click();
    await expect(number).toHaveValue(outOfRange);
    await expect(start).toHaveAttribute("aria-disabled", "true");
  });
}

for (const source of ["recovery", "stop"] as const) {
  test(`returns to setup and starts a new guest session after ${source} access expires`, async ({
    page,
  }) => {
    await openSetup(page);
    await configure(page, "White");
    await configure(page, "Black");
    const createdResponse = page.waitForResponse(
      (response) => response.url() === API_ORIGIN + "/ai/games",
    );
    await page.getByRole("button", { name: "Start game" }).click();
    const created = await createdResponse;
    expect(created.status()).toBe(201);
    const initial = gameSnapshotSchema.parse(await created.json());
    if (source === "recovery") {
      await page.reload();
      await expect(page.getByRole("button", { name: "Return to game" })).toBeVisible();
    } else {
      // Quiesce playback so this case tests expiry on Stop, not the newly automatic turn.
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(page.getByRole("button", { name: "Next move" })).toHaveAttribute(
        "aria-disabled",
        "false",
      );
    }
    const database = integrationDatabase();
    try {
      const [owner] = await database.db
        .select({ id: games.ownerGuestSessionId })
        .from(games)
        .where(eq(games.id, initial.gameId));
      if (!owner) throw new Error("Test game owner missing");
      await database.db
        .update(guestSessions)
        .set({
          lastSeenAt: sql`clock_timestamp() - interval '2 hours'`,
          expiresAt: sql`clock_timestamp() - interval '1 hour'`,
        })
        .where(eq(guestSessions.id, owner.id));
      const url =
        source === "stop"
          ? `${API_ORIGIN}/games/${initial.gameId}/lifecycle`
          : `${API_ORIGIN}/ai/games/${initial.gameId}`;
      allowUnauthorizedResponse(page, url);
      const failedResponse = page.waitForResponse((response) => response.url() === url);
      if (source === "recovery") await page.getByRole("button", { name: "Return to game" }).click();
      else {
        await page.getByRole("button", { name: "Stop game" }).click();
        await page.getByRole("dialog").getByRole("button", { name: "Stop game" }).click();
      }
      expect((await failedResponse).status()).toBe(401);
      const exit = page.getByRole("button", { name: "Return to setup" });
      await expect(exit).toBeVisible();
      await expect(page.getByRole("grid", { name: "Chessboard" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Retry recovery" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Stop game" })).toHaveCount(0);
      const bootstrap = page.waitForResponse(
        (response) => response.url() === API_ORIGIN + "/guest-session",
      );
      await exit.click();
      expect((await bootstrap).status()).toBe(200);
      await expect(page.getByRole("button", { name: "Return to game" })).toHaveCount(0);
      await configure(page, "White");
      await configure(page, "Black");
      const nextResponse = page.waitForResponse(
        (response) => response.url() === API_ORIGIN + "/ai/games",
      );
      await page.getByRole("button", { name: "Start game" }).click();
      const next = await nextResponse;
      expect(next.status()).toBe(201);
      const current = gameSnapshotSchema.parse(await next.json());
      const [newOwner] = await database.db
        .select({ id: games.ownerGuestSessionId })
        .from(games)
        .where(eq(games.id, current.gameId));
      expect(newOwner?.id).toBeTruthy();
      expect(newOwner?.id).not.toBe(owner.id);
      await expect(page.getByRole("heading", { name: "Game created" })).toBeVisible();
      await assertNoKeysStored(page);
    } finally {
      await database.close();
    }
  });
}

test("creates a match with disjoint catalogs from two keys for the same provider", async ({
  page,
}) => {
  await openSetup(page);
  await configure(page, "White", "openai", "fixture-white-disjoint", "white-only model");
  await configure(page, "Black", "openai", "fixture-black-disjoint", "black-only model");
  const response = page.waitForResponse((response) => response.url() === API_ORIGIN + "/ai/games");
  await page.getByRole("button", { name: "Start game" }).click();
  const created = await response;
  expect(created.status()).toBe(201);
  const request = createAiGameRequestSchema.parse(created.request().postDataJSON() as unknown);
  expect(request.mode).toBe("ai_vs_ai");
  if (request.mode !== "ai_vs_ai") throw new Error("Unexpected test game mode");
  expect(request.white.modelId).toBe("white-only-model");
  expect(request.black.modelId).toBe("black-only-model");
  expect(request.white.catalogId).toBeTruthy();
  expect(request.white.catalogId).not.toBe(request.black.catalogId);
  await expect(page.getByRole("heading", { name: "Game created" })).toBeVisible();
  await assertNoKeysStored(page);
});

test("does not carry reveal state between the White and opponent drafts", async ({ page }) => {
  await openSetup(page);
  await page.getByRole("radio", { name: /AI vs human/ }).check();
  await configure(page, "Black", "openai", "fixture-opponent-key");
  await page.getByRole("radio", { name: /AI vs AI/ }).check();
  await configure(page, "White");
  await page
    .getByRole("region", { name: "White configuration" })
    .getByRole("button", { name: "Show key" })
    .click();
  await page.getByRole("radio", { name: /AI vs human/ }).check();
  const opponent = page.getByRole("region", { name: "Black configuration" });
  await expect(opponent.getByLabel("API key", { exact: true })).toHaveValue("fixture-opponent-key");
  await expect(opponent.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
  await opponent.getByRole("button", { name: "Show key" }).click();
  await page.getByRole("radio", { name: /AI vs AI/ }).check();
  await expect(
    page
      .getByRole("region", { name: "White configuration" })
      .getByLabel("API key", { exact: true }),
  ).toHaveAttribute("type", "password");
  await assertNoKeysStored(page);
});

async function assertNoKeysStored(page: Page) {
  const persisted = await page.evaluate(async () =>
    JSON.stringify({
      local: Object.fromEntries(
        Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
      ),
      session: Object.fromEntries(
        Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]),
      ),
      state: history.state as unknown,
      url: location.href,
      cookie: document.cookie,
      databases: await indexedDB.databases(),
      caches: await caches.keys(),
    }),
  );
  expect(persisted).not.toContain("fixture-");
}

test("independent identical-model setup, credential-free creation, refresh loss, and paused return", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    let writes = 0;
    const original = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem")?.value as (
      this: Storage,
      name: string,
      value: string,
    ) => void;
    Storage.prototype.setItem = function (name, value) {
      writes++;
      original.call(this, name, value);
    };
    Object.defineProperty(window, "setupStorageWrites", { get: () => writes });
  });
  let turns = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/ai-turn")) turns++;
  });
  await openSetup(page);
  await expect(page.getByRole("radio", { name: /AI vs AI/ })).toBeChecked();
  const start = page.getByRole("button", { name: "Start game" });
  await expect(start).toHaveAttribute("aria-disabled", "true");
  const white = await configure(page, "White");
  await white.getByText("Advanced parameters").click();
  await white.getByRole("spinbutton", { name: "Temperature" }).fill("0");
  const black = await configure(page, "Black");
  await black.getByText("Advanced parameters").click();
  await black.getByRole("spinbutton", { name: "Temperature" }).fill("1.5");
  await black.getByRole("combobox", { name: "Reasoning effort" }).selectOption("high");
  await black.getByRole("spinbutton", { name: "Maximum output tokens" }).fill("256");
  await white.getByRole("button", { name: "Show key" }).click();
  await expect(white.getByLabel("API key", { exact: true })).toHaveAttribute("type", "text");
  await expect(black.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password");
  await white.getByRole("button", { name: "Hide key" }).click();
  await expect(white.getByRole("spinbutton", { name: "Temperature" })).toHaveValue("0");
  await assertNoKeysStored(page);
  expect(await page.evaluate(() => Reflect.get(window, "setupStorageWrites") as unknown)).toBe(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: join(tmpdir(), `neurochess-ai-setup-${info.project.name}.png`),
    fullPage: true,
  });
  const response = page.waitForResponse(
    (response) =>
      response.url() === API_ORIGIN + "/ai/games" && response.request().method() === "POST",
  );
  await start.click();
  const created = await response;
  expect(created.status()).toBe(201);
  expect(createAiGameRequestSchema.parse(created.request().postDataJSON() as unknown)).toEqual({
    mode: "ai_vs_ai",
    white: {
      provider: "openai",
      modelId: "fixture-full",
      parameters: { temperature: 0 },
      catalogId: expect.any(String) as unknown,
    },
    black: {
      provider: "openai",
      modelId: "fixture-full",
      parameters: { temperature: 1.5, reasoningEffort: "high", maxOutputTokens: 256 },
      catalogId: expect.any(String) as unknown,
    },
  });
  const snapshot = gameSnapshotSchema.parse(await created.json());
  await expect(page.getByRole("heading", { name: "Game created" })).toBeVisible();
  await expect(page.getByRole("grid", { name: "Chessboard" })).toBeVisible();
  expect(snapshot.moves).toEqual([]);
  await expect.poll(() => turns).toBe(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "Return to game" })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "White configuration" })
      .getByLabel("API key", { exact: true }),
  ).toHaveValue("");
  await expect(
    page
      .getByRole("region", { name: "Black configuration" })
      .getByLabel("API key", { exact: true }),
  ).toHaveValue("");
  await assertNoKeysStored(page);
  await page.getByRole("button", { name: "Return to game" }).click();
  await expect(page.getByText("Game paused", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop game" }).click();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.getByRole("dialog").getByRole("button", { name: "Stop game" }).click();
  await expect(page.getByText(/Game stopped/).first()).toBeVisible();
  await page.getByRole("button", { name: "Configure another match" }).click();
  await expect(page.getByRole("button", { name: "Return to game" })).toHaveCount(0);
  expect(turns).toBe(1);
});

for (const color of ["White", "Black"] as const) {
  test(`AI vs human supports human ${color} and independent mode state`, async ({ page }) => {
    await openSetup(page);
    await configure(page, "White");
    await page.getByRole("radio", { name: /AI vs human/ }).check();
    await page
      .getByRole("group", { name: "Your color" })
      .getByRole("radio", { name: color })
      .check();
    await configure(page, color === "White" ? "Black" : "White", "anthropic", "fixture-opponent");
    await expect(page.getByRole("region", { name: /configuration/ })).toHaveCount(1);
    await page.getByRole("radio", { name: /AI vs AI/ }).check();
    await expect(
      page
        .getByRole("region", { name: "White configuration" })
        .getByLabel("API key", { exact: true }),
    ).toHaveValue("fixture-White-key");
    await page.getByRole("radio", { name: /AI vs human/ }).check();
    const response = page.waitForResponse(
      (response) => response.url() === API_ORIGIN + "/ai/games",
    );
    await page.getByRole("button", { name: "Start game" }).click();
    const created = await response;
    expect(created.status()).toBe(201);
    expect(createAiGameRequestSchema.parse(created.request().postDataJSON() as unknown)).toEqual({
      mode: "ai_vs_human",
      humanColor: color.toLowerCase(),
      ai: {
        provider: "anthropic",
        modelId: "fixture-full",
        parameters: {},
        catalogId: expect.any(String) as unknown,
      },
    });
    await assertNoKeysStored(page);
    await expect(page.getByRole("heading", { name: "Game created" })).toBeVisible();
  });
}

test("discovery errors, empty results, capabilities, model filtering, and start validation", async ({
  page,
}) => {
  await openSetup(page);
  const white = page.getByRole("region", { name: "White configuration" });
  await white.getByRole("combobox", { name: "Provider" }).selectOption("openai");
  await white.getByLabel("API key", { exact: true }).fill("fixture-auth");
  await white.getByRole("button", { name: "Load models" }).click();
  await expect(white.getByText(/provider rejected this key/)).toBeVisible();
  await white.getByLabel("API key", { exact: true }).fill("fixture-empty");
  await white.getByRole("button", { name: "Load models" }).click();
  await expect(white.getByText(/No models are available/)).toBeVisible();
  await configure(page, "White");
  await configure(page, "Black", "google");
  await white.getByText("Advanced parameters").click();
  const tokens = white.getByRole("spinbutton", { name: "Maximum output tokens" });
  await tokens.fill("4096");
  await expect(page.getByRole("button", { name: "Start game" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await tokens.fill("64");
  await expect(page.getByRole("button", { name: "Start game" })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await tokens.fill("");
  await tokens.press("e");
  await expect(page.getByRole("button", { name: "Start game" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await tokens.fill("64");
  const picker = white.getByRole("combobox", { name: "Model", exact: true });
  await picker.fill("no such model");
  await expect(white.getByText(/No matching models/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Start game" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await picker.fill("Fixture basic");
  await picker.press("Enter");
  await expect(white.getByText(/no advertised optional parameters/)).toBeVisible();
  await expect(white.getByRole("spinbutton")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start game" })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await white.getByRole("combobox", { name: "Provider" }).selectOption("openrouter");
  await expect(white.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(white.getByRole("combobox", { name: "Model", exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Black configuration" })
      .getByRole("combobox", { name: "Provider" }),
  ).toHaveValue("google");
});

test("setup fits supported widths and enlarged text with accessible controls", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "Desktop viewport resizing check");
  await openSetup(page);
  await configure(page, "White");
  await configure(page, "Black");
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(page.getByRole("button", { name: "Start game" })).toBeVisible();
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await page.setViewportSize({ width: 390, height: 1000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(async () => {
    const modulePath = "/src/i18n/index.ts";
    const { i18n } = (await import(/* @vite-ignore */ modulePath)) as typeof webI18n;
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
    await i18n.changeLanguage("en-XA");
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
