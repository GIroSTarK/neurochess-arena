import { randomUUID } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import {
  type AiProvider,
  credentialMetadataSchema,
  gameDetailsSchema,
  gamePgnResponseSchema,
} from "@neurochess/contracts";
import { authSchema, games, providerCredentials } from "@neurochess/database";
import type { Page } from "@playwright/test";
import { eq, inArray } from "drizzle-orm";

import { AUTH_ENVIRONMENT, fixtureAuth, registerFixture } from "../../apps/api/test/auth-helpers";
import { integrationDatabase } from "../database";

import { observeCredentialPrivacy } from "./credential-privacy";
import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, readSnapshot, square, test } from "./fixtures";
import { expectUnbrokenWords, setPseudoLocalization } from "./text-layout";

test.use({ allowIdentityLoss: true });
const whiteKey = "saved-white-fixture-sentinel";
const blackKey = "saved-black-fixture-sentinel";
const rawKey = "tab-only-fixture-sentinel";
async function fixture() {
  const database = integrationDatabase();
  const auth = fixtureAuth(database, {
    ...AUTH_ENVIRONMENT,
    WEB_ORIGIN,
    BETTER_AUTH_URL: API_ORIGIN,
  });
  const accounts = [await registerFixture(auth), await registerFixture(auth)];
  const ids = accounts.map((account) => account.userId);
  await database.db
    .update(authSchema.user)
    .set({ emailVerified: true })
    .where(inArray(authSchema.user.id, ids));
  return {
    database,
    accounts,
    async close() {
      await database.db.delete(games).where(inArray(games.ownerUserId, ids));
      await database.db.delete(authSchema.user).where(inArray(authSchema.user.id, ids));
      await database.close();
    },
  };
}
async function login(page: Page, account: { email: string; password: string }, onboard = true) {
  const headers = { origin: WEB_ORIGIN };
  expect(
    (
      await page.request.post(API_ORIGIN + "/api/auth/sign-in/email", {
        headers,
        data: { email: account.email, password: account.password },
      })
    ).ok(),
  ).toBe(true);
  if (onboard) {
    expect(
      (
        await page.request.post(API_ORIGIN + "/api/profile/onboarding", {
          headers,
          data: {
            username: "Keys_" + randomUUID().replaceAll("-", "").slice(0, 15),
            avatar: "initials",
          },
        })
      ).ok(),
    ).toBe(true);
  }
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Set up a game" })).toBeVisible();
}
async function save(page: Page, provider: AiProvider, label: string, apiKey: string) {
  const response = await page.request.post(API_ORIGIN + "/api/credentials", {
    headers: { origin: WEB_ORIGIN },
    data: { save: true, provider, label, apiKey },
  });
  expect(response.status()).toBe(201);
  const payload: unknown = await response.json();
  expect(JSON.stringify(payload).includes(apiKey)).toBe(false);
  return credentialMetadataSchema.parse(payload).credentialId;
}
async function configure(
  page: Page,
  color: "White" | "Black",
  source: string | null,
  key = rawKey,
) {
  const seat = page.getByRole("group", { name: color, exact: true });
  await expect(seat.getByLabel("Provider", { exact: true })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await seat
    .getByLabel("Provider", { exact: true })
    .selectOption(color === "White" ? "openai" : "google");
  if (source) {
    await seat.getByLabel("Credential source").selectOption("saved");
    await expect(seat.getByLabel("Saved key", { exact: true })).toHaveValue("");
    await seat.getByLabel("Saved key", { exact: true }).selectOption(source);
    await expect(seat.getByLabel("API key", { exact: true })).toHaveCount(0);
  } else await seat.getByLabel("API key", { exact: true }).fill(key);
  await seat.getByRole("button", { name: "Load models", exact: true }).click();
  const model = seat.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveAttribute("aria-disabled", "false");
  await model.fill("model-a");
  await model.press("ArrowDown");
  await model.press("Enter");
}
async function start(page: Page) {
  const response = page.waitForResponse(
    (response) => response.url() === API_ORIGIN + "/games" && response.status() === 201,
  );
  await page.getByRole("button", { name: "Start game", exact: true }).click();
  return gameDetailsSchema.parse(await (await response).json()).snapshot.gameId;
}
async function selectRecovery(page: Page, color: "White" | "Black", credentialId: string) {
  const seat = page.getByRole("group", {
    name: color + " · " + (color === "White" ? "OpenAI" : "Google"),
    exact: true,
  });
  await seat.getByLabel("Credential source").selectOption("saved");
  await expect(seat.getByLabel("Saved key", { exact: true })).toHaveValue("");
  await seat.getByLabel("Saved key", { exact: true }).selectOption(credentialId);
}

test("settings opt-in, masked metadata, Cancel-first revoke/clear and responsive accessibility", async ({
  page,
}, testInfo) => {
  const f = await fixture();
  try {
    await login(page, f.accounts[0]!);
    const privateState = observeCredentialPrivacy(page, [whiteKey, blackKey]);
    await page.goto("/account#credentials");
    const settings = page.getByRole("region", { name: "Saved provider keys" });
    await expect(settings).toBeVisible();
    const consent = settings.getByRole("checkbox", { name: "Save this key to my account" });
    await expect(consent).not.toBeChecked();
    await settings.getByLabel("Label", { exact: true }).fill("Personal key");
    await settings.getByLabel("API key", { exact: true }).fill(whiteKey);
    await expect(settings.getByRole("button", { name: "Save key", exact: true })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await consent.check();
    const savedResponse = page.waitForResponse(
      (response) => response.url() === API_ORIGIN + "/api/credentials" && response.status() === 201,
    );
    await settings.getByRole("button", { name: "Save key", exact: true }).click();
    const payload: unknown = await (await savedResponse).json();
    expect(JSON.stringify(payload).includes(whiteKey)).toBe(false);
    await expect(consent).not.toBeChecked();
    await expect(settings.getByLabel("API key", { exact: true })).toHaveValue("");
    await expect(settings.getByText("Personal key", { exact: true })).toBeVisible();
    await privateState();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await settings.getByRole("button", { name: "Revoke Personal key" }).click();
    await expect(
      page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    await settings.getByRole("button", { name: "Revoke Personal key" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Revoke key", exact: true }).click();
    await expect(settings.getByText("Personal key", { exact: true })).toHaveCount(0);
    await save(page, "google", "Another key", blackKey);
    await settings.getByRole("button", { name: "Refresh saved keys" }).click();
    await expect(settings.getByText("Another key", { exact: true })).toBeVisible();
    await settings.getByRole("button", { name: "Clear all saved keys" }).click();
    await expect(
      page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }),
    ).toBeFocused();
    await page.getByRole("dialog").getByRole("button", { name: "Clear all saved keys" }).click();
    await expect(settings.getByText("You have no saved provider keys.")).toBeVisible();
    await page.setViewportSize({
      width: testInfo.project.name === "desktop" ? 1024 : 320,
      height: 900,
    });
    await setPseudoLocalization(page, true);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await expectUnbrokenWords(settings);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath("credential-settings-expanded.png"),
      fullPage: true,
    });
  } finally {
    await f.close();
  }
});

for (const sources of ["raw/raw", "saved/saved", "saved/raw", "raw/saved"] as const) {
  test(`${sources} independent AI seats use exclusive sources; refresh requires explicit selection and step`, async ({
    page,
  }) => {
    const f = await fixture();
    try {
      await login(page, f.accounts[0]!);
      const white = await save(page, "openai", "White saved", whiteKey);
      const black = await save(page, "google", "Black saved", blackKey);
      await page.reload();
      const privateState = observeCredentialPrivacy(page, [whiteKey, blackKey, rawKey]);
      const calls: { source: "saved" | "raw"; id?: string }[] = [];
      let leaks = false;
      const responseReads: Promise<void>[] = [];
      // Reload aborts in-flight polling; inspect bodies only after their download completes.
      page.on("requestfinished", (request) => {
        if (request.url().startsWith(API_ORIGIN)) {
          responseReads.push(
            request
              .response()
              .then(async (response) => {
                if (!response) return;
                const body = await response.text();
                leaks ||= [whiteKey, blackKey, rawKey].some((key) => body.includes(key));
              })
              .catch(() => undefined),
          );
        }
      });
      page.on("request", (request) => {
        if (request.url().endsWith("/ai-turn")) {
          const body = request.postDataJSON() as { credentialId?: string; apiKey?: string };
          expect(Boolean(body.apiKey) !== Boolean(body.credentialId)).toBe(true);
          calls.push(
            body.credentialId ? { source: "saved", id: body.credentialId } : { source: "raw" },
          );
        }
      });
      await configure(page, "White", sources.startsWith("saved") ? white : null);
      await configure(page, "Black", sources.endsWith("saved") ? black : null);
      const gameId = await start(page);
      await page.getByLabel("Delay between moves").selectOption("5000");
      await expect.poll(async () => (await readSnapshot(page, gameId)).moves.length).toBe(1);
      expect(calls[0]).toEqual(
        sources.startsWith("saved") ? { source: "saved", id: white } : { source: "raw" },
      );
      await expect.poll(async () => (await readSnapshot(page, gameId)).moves.length).toBe(2);
      expect(calls[1]).toEqual(
        sources.endsWith("saved") ? { source: "saved", id: black } : { source: "raw" },
      );
      await page.reload();
      await expect(page.getByRole("region", { name: "Choose keys to continue" })).toBeVisible();
      const count = calls.length;
      await selectRecovery(page, "White", white);
      await selectRecovery(page, "Black", black);
      expect(calls).toHaveLength(count);
      expect((await readSnapshot(page, gameId)).state).toBe("paused");
      await privateState();
      // Server snapshots can advance before the browser response enters the leak audit.
      await Promise.all([
        page.waitForEvent(
          "requestfinished",
          (request) =>
            request.method() === "POST" &&
            request.url() === `${API_ORIGIN}/games/${gameId}/ai-turn`,
        ),
        page.getByRole("button", { name: "Next move", exact: true }).click(),
      ]);
      await expect.poll(async () => (await readSnapshot(page, gameId)).moves.length).toBe(3);
      expect(calls.at(-1)).toEqual({ source: "saved", id: white });
      expect((await readSnapshot(page, gameId)).state).toBe("paused");
      await Promise.all(responseReads);
      expect(leaks).toBe(false);
    } finally {
      await f.close();
    }
  });
}

for (const human of ["white", "black"] as const) {
  test(`saved AI opponent with ${human} human survives refresh without automatic continuation`, async ({
    page,
  }) => {
    const f = await fixture();
    try {
      await login(page, f.accounts[0]!);
      const ai = human === "white" ? "Black" : "White";
      const id = await save(page, human === "white" ? "google" : "openai", "Opponent", whiteKey);
      await page.reload();
      await page.getByLabel("Game mode").selectOption("ai_vs_human");
      await page.getByLabel("Your color").selectOption(human);
      await configure(page, ai, id);
      const gameId = await start(page);
      if (human === "black") {
        await expect.poll(async () => (await readSnapshot(page, gameId)).moves.length).toBe(1);
      }
      await page.reload();
      await expect(page.getByRole("region", { name: "Choose keys to continue" })).toBeVisible();
      await expect(page.getByLabel("Credential source")).toHaveCount(1);
      await selectRecovery(page, ai, id);
      expect((await readSnapshot(page, gameId)).state).toBe("paused");
      await page.getByRole("button", { name: "Resume game", exact: true }).click();
      await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
      await square(page, human === "white" ? "f2" : "e7").click();
      await square(page, human === "white" ? "f3" : "e5").click();
      await expect
        .poll(async () => (await readSnapshot(page, gameId)).moves.length)
        .toBe(human === "white" ? 2 : 3);
    } finally {
      await f.close();
    }
  });
}

test("independent account sessions recover saved keys and complete both AI modes into private history", async ({
  page,
  browser,
}, testInfo) => {
  const f = await fixture();
  const device = await browser.newContext({
    baseURL: WEB_ORIGIN,
    viewport: page.viewportSize(),
    isMobile: testInfo.project.use.isMobile ?? false,
    hasTouch: testInfo.project.use.hasTouch ?? false,
  });
  const returning = await device.newPage();
  try {
    const account = f.accounts[0]!;
    await login(page, account);
    const black = await save(page, "google", "Cross-device opponent", blackKey);
    const privateOriginal = observeCredentialPrivacy(page, [blackKey, rawKey]);
    const privateReturning = observeCredentialPrivacy(returning, [blackKey, rawKey]);
    await page.reload();
    await page.getByLabel("Game mode").selectOption("ai_vs_human");
    await configure(page, "Black", black);
    const humanGame = await start(page);
    await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    await square(page, "f2").click();
    await square(page, "f3").click();
    await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    const beforeRecovery = await readSnapshot(page, humanGame);
    expect(beforeRecovery.state).toBe("active");
    expect(beforeRecovery.moves.map((move) => move.uci)).toEqual(["f2f3", "e7e5"]);

    // Separate cookies and storage exercise another device, not a same-session tab.
    await login(returning, account, false);
    let turns = 0;
    returning.on("request", (request) => {
      if (request.url().endsWith("/ai-turn")) turns++;
    });
    await returning.getByRole("button", { name: "Return to game" }).click();
    await expect(returning.getByRole("region", { name: "Choose keys to continue" })).toBeVisible();
    const recovered = await readSnapshot(returning, humanGame);
    expect(recovered.state).toBe("paused");
    expect(recovered.moves).toEqual(beforeRecovery.moves);
    await expect(returning.getByLabel("Black · Google · API key", { exact: true })).toHaveValue("");
    await selectRecovery(returning, "Black", black);
    expect(turns).toBe(0);
    expect((await readSnapshot(returning, humanGame)).state).toBe("paused");

    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByText(/You are signed out or your session has ended/)).toBeVisible();
    await expect(page.getByRole("grid")).toHaveCount(0);
    await returning.getByRole("button", { name: "Resume game", exact: true }).click();
    await expect(returning.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    await square(returning, "g2").click();
    await square(returning, "g4").click();
    await expect(returning.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
    expect(turns).toBe(1);
    const humanResult = await readSnapshot(returning, humanGame);
    expect(humanResult).toMatchObject({ state: "completed", result: "0-1" });
    expect(humanResult.moves.map((move) => move.uci)).toEqual(["f2f3", "e7e5", "g2g4", "d8h4"]);

    await returning.goto("/");
    await configure(returning, "White", null);
    await configure(returning, "Black", black);
    const aiGame = await start(returning);
    await expect(returning.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
    const aiResult = await readSnapshot(returning, aiGame);
    expect(aiResult).toMatchObject({ state: "completed", result: "0-1" });
    expect(aiResult.moves.map((move) => move.uci)).toEqual(["f2f3", "e7e5", "g2g4", "d8h4"]);

    expect(
      (
        await returning.request.post(`${API_ORIGIN}/api/credentials/${black}/revoke`, {
          headers: { origin: WEB_ORIGIN },
          data: {},
        })
      ).ok(),
    ).toBe(true);
    await login(page, account, false);
    let providerReads = 0;
    page.on("request", (request) => {
      if (request.url().includes("/providers/") || request.url().endsWith("/ai-turn")) {
        providerReads++;
      }
    });
    await page.goto("/history");
    await expect(page.getByRole("link", { name: "Replay game", exact: true })).toHaveCount(2);
    for (const result of [humanResult, aiResult]) {
      await page.locator(`a[href="/?game=${result.gameId}"]`).click();
      await expect(page.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
      await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
      const pgn = await page.request.get(`${API_ORIGIN}/games/${result.gameId}/pgn`);
      expect(pgn.status()).toBe(200);
      expect(gamePgnResponseSchema.parse(await pgn.json()).pgn).toBe(result.pgn);
      await page.goto("/history");
    }
    expect(providerReads).toBe(0);
    await privateOriginal();
    await privateReturning();
  } finally {
    await device.close();
    await f.close();
  }
});

for (const reason of ["revoked", "undecryptable", "rejected"] as const) {
  test(`${reason} saved key pauses safely and accepts an explicit replacement`, async ({
    page,
  }) => {
    const f = await fixture();
    try {
      await login(page, f.accounts[0]!);
      const id = await save(
        page,
        "openai",
        "Selected key",
        reason === "rejected" ? "expired-fixture" : whiteKey,
      );
      await page.reload();
      await page.getByLabel("Game mode").selectOption("ai_vs_human");
      await page.getByLabel("Your color").selectOption("black");
      await configure(page, "White", id);
      if (reason === "revoked") {
        expect(
          (
            await page.request.post(API_ORIGIN + `/api/credentials/${id}/revoke`, {
              headers: { origin: WEB_ORIGIN },
              data: {},
            })
          ).ok(),
        ).toBe(true);
      } else if (reason === "undecryptable") {
        await f.database.db
          .update(providerCredentials)
          .set({ keyId: "unavailable-test-key" })
          .where(eq(providerCredentials.id, id));
      }
      const gameId = await start(page);
      await expect(page.getByText(/This credential could not be used/)).toBeVisible();
      expect((await readSnapshot(page, gameId)).state).toBe("paused");
      expect((await readSnapshot(page, gameId)).moves).toHaveLength(0);
      await page.getByLabel("White · OpenAI · API key", { exact: true }).fill(rawKey);
      expect((await readSnapshot(page, gameId)).moves).toHaveLength(0);
      await page.getByRole("button", { name: "Next move", exact: true }).click();
      await expect.poll(async () => (await readSnapshot(page, gameId)).moves.length).toBe(1);
      expect((await readSnapshot(page, gameId)).state).toBe("paused");
    } finally {
      await f.close();
    }
  });
}

test("account switching fences a delayed saved-key list and clears selected and raw seat state", async ({
  page,
  context,
}) => {
  const f = await fixture();
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await login(page, f.accounts[0]!);
    const id = await save(page, "openai", "Previous account private label", whiteKey);
    await page.reload();
    await configure(page, "White", id);
    await configure(page, "Black", null);
    await page.route(
      "**/api/credentials",
      async (route) => {
        const response = await route.fetch();
        received.resolve();
        await release.promise;
        await route.fulfill({ response }).catch(() => undefined);
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: "Refresh saved keys" }).click();
    await received.promise;
    const other = await context.newPage();
    await other.goto("/auth/sign-in");
    await other.getByLabel("Email", { exact: true }).fill(f.accounts[1]!.email);
    await other.getByLabel("Password", { exact: true }).fill(f.accounts[1]!.password);
    await other.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Choose your arena identity" })).toBeVisible();
    release.resolve();
    await page
      .getByLabel("Username", { exact: true })
      .fill("Other_" + randomUUID().replaceAll("-", "").slice(0, 14));
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByRole("heading", { name: "Set up a game" })).toBeVisible();
    await expect(page.getByLabel("API key", { exact: true }).first()).toHaveValue("");
    await expect(page.getByLabel("API key", { exact: true }).last()).toHaveValue("");
    await page.getByLabel("Credential source").first().selectOption("saved");
    await expect(page.getByRole("option", { name: /Previous account private label/ })).toHaveCount(
      0,
    );
    await other.close();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByText(/You are signed out or your session has ended/)).toBeVisible();
    await observeCredentialPrivacy(page, [whiteKey, rawKey])();
  } finally {
    release.resolve();
    await f.close();
  }
});
