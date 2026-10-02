import { randomUUID } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import { credentialListResponseSchema, type ProviderCredentialSource } from "@neurochess/contracts";
import { providerCredentials } from "@neurochess/database";
import { and, eq } from "drizzle-orm";

import { integrationDatabase } from "../database";

import {
  configureCredential,
  credentialAccount,
  saveCredential,
  startCredentialGame,
} from "./credential-helpers";
import { observeCredentialPrivacy } from "./credential-privacy";
import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, readSnapshot, test } from "./fixtures";
import { setPseudoLocalization } from "./text-layout";

for (const combination of ["raw/raw", "saved/saved", "mixed"] as const) {
  test(`account AI seats use ${combination} sources and recover only after explicit selection`, async ({
    page,
  }, testInfo) => {
    await credentialAccount(page);
    const whiteKey = "white-fixture-1234";
    const blackKey = "black-fixture-5678";
    const privateValues = observeCredentialPrivacy(page, [whiteKey, blackKey]);
    const operations: ProviderCredentialSource[] = [];
    const turns: ProviderCredentialSource[] = [];
    let exposed = false;
    const responseChecks: Promise<void>[] = [];
    page.on("request", (request) => {
      if (/\/(models|ai-turn)$/.test(new URL(request.url()).pathname)) {
        const body = request.postDataJSON() as ProviderCredentialSource;
        operations.push(body);
        if (request.url().endsWith("/ai-turn")) turns.push(body);
      }
    });
    // Navigation and app aborts can cancel or discard a response body before the
    // browser exposes it, so inspect each API body before the page receives it.
    await page.route(API_ORIGIN + "/**", (route) => {
      if (route.request().url().includes("/api/auth/")) return route.fallback();
      const check = route.fetch().then(async (response) => {
        const text = await response.text();
        if ([whiteKey, blackKey].some((key) => text.includes(key))) exposed = true;
        await route.fulfill({ response });
      });
      responseChecks.push(check);
      return check;
    });
    await page.goto("/account/credentials");
    const white =
      combination === "raw/raw" ? null : await saveCredential(page, "White saved", whiteKey);
    const black =
      combination !== "saved/saved"
        ? null
        : await saveCredential(page, "Black saved", blackKey, "anthropic");
    await page.goto("/");
    await configureCredential(
      page,
      "White",
      white ? { credentialId: white.credentialId } : { apiKey: whiteKey },
    );
    await configureCredential(
      page,
      "Black",
      black ? { credentialId: black.credentialId } : { apiKey: blackKey },
      "anthropic",
    );
    const game = await startCredentialGame(page);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
    const before = await readSnapshot(page, game.snapshot.gameId);
    const count = turns.length;
    for (const [color, provider, saved, key] of [
      ["White", "OpenAI", white, whiteKey],
      ["Black", "Anthropic", black, blackKey],
    ] as const) {
      const source = page.getByLabel(`${color} · ${provider} · Credential source`, { exact: true });
      await expect(source).toHaveValue("session");
      await expect(
        page.getByLabel(`${color} · ${provider} · API key`, { exact: true }),
      ).toHaveValue("");
      if (saved) await source.selectOption(saved.credentialId);
      else await page.getByLabel(`${color} · ${provider} · API key`, { exact: true }).fill(key);
    }
    expect(turns).toHaveLength(count);
    expect((await readSnapshot(page, game.snapshot.gameId)).state).toBe("paused");
    for (let index = 1; index <= 2; index++) {
      await page.getByRole("button", { name: "Next move", exact: true }).click();
      await expect
        .poll(async () => (await readSnapshot(page, game.snapshot.gameId)).moves.length)
        .toBe(before.moves.length + index);
    }
    expect(
      turns
        .slice(count)
        .map((body) => ("credentialId" in body ? body.credentialId : body.apiKey))
        .sort(),
    ).toEqual([white?.credentialId ?? whiteKey, black?.credentialId ?? blackKey].sort());
    for (const body of operations) {
      expect("credentialId" in body !== "apiKey" in body).toBe(true);
      if (white) expect("apiKey" in body && body.apiKey === whiteKey).toBe(false);
      if (black) expect("apiKey" in body && body.apiKey === blackKey).toBe(false);
    }
    await privateValues();
    await page.unrouteAll({ behavior: "wait" });
    await Promise.all(responseChecks);
    expect(exposed).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath(`credentials-${combination.replace("/", "-")}.png`),
      fullPage: true,
    });
  });
}

for (const human of ["white", "black"] as const) {
  test(`a ${human} human recovers with only the opposing saved AI credential`, async ({ page }) => {
    await credentialAccount(page);
    await page.goto("/account/credentials");
    const saved = await saveCredential(page, "Opponent key", "opponent-fixture-1234", "google");
    await page.goto("/");
    await expect(page.getByLabel("Game mode")).toHaveAttribute("aria-disabled", "false");
    await page.getByLabel("Game mode").selectOption("ai_vs_human");
    await page.getByLabel("Your color").selectOption(human);
    const ai = human === "white" ? "Black" : "White";
    await configureCredential(page, ai, { credentialId: saved.credentialId }, "google");
    const game = await startCredentialGame(page);
    if (human === "black") {
      await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    }
    await page.reload();
    await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
    await expect(page.getByLabel(/Credential source/)).toHaveCount(1);
    await page.getByLabel(`${ai} · Google · Credential source`).selectOption(saved.credentialId);
    expect((await readSnapshot(page, game.snapshot.gameId)).state).toBe("paused");
    await page.getByRole("button", { name: "Resume game", exact: true }).click();
    await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    const [from, to] = human === "white" ? ["f2", "f3"] : ["e7", "e5"];
    await page.locator(`[data-square="${from}"]`).click();
    await page.locator(`[data-square="${to}"]`).click();
    await expect
      .poll(async () => (await readSnapshot(page, game.snapshot.gameId)).moves.length)
      .toBe(human === "white" ? 2 : 3);
  });
}

test("settings confirms individual revoke and clear-all, and revocation removes an in-use setup selection", async ({
  page,
  context,
}, testInfo) => {
  await credentialAccount(page);
  await page.goto("/account/credentials");
  const first = await saveCredential(page, "First saved", "first-fixture-1234");
  await saveCredential(page, "Second saved", "second-fixture-5678");
  const settings = await context.newPage();
  try {
    await settings.goto(WEB_ORIGIN + "/account/credentials");
    await page.goto("/");
    await configureCredential(page, "White", { credentialId: first.credentialId });
    await settings.getByRole("button", { name: "Revoke First saved" }).click();
    let dialog = settings.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(settings.getByText("First saved", { exact: true })).toBeVisible();
    await settings.getByRole("button", { name: "Revoke First saved" }).click();
    dialog = settings.getByRole("dialog");
    await dialog.getByRole("button", { name: "Revoke key", exact: true }).click();
    const seat = page.getByRole("group", { name: "White", exact: true });
    await expect(seat.getByLabel("Credential source")).toHaveValue("session");
    await expect(seat.getByLabel("API key", { exact: true })).toHaveValue("");
    await expect(seat.getByRole("combobox", { name: "Model", exact: true })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await settings.getByRole("button", { name: "Clear all saved keys", exact: true }).click();
    await expect(
      settings.getByRole("dialog").getByRole("button", { name: "Cancel" }),
    ).toBeFocused();
    await settings
      .getByRole("dialog")
      .getByRole("button", { name: "Clear all saved keys", exact: true })
      .click();
    await expect(settings.getByText(/No saved keys yet/)).toBeVisible();
    const response = await settings.request.get(API_ORIGIN + "/credentials");
    expect(credentialListResponseSchema.parse(await response.json()).credentials).toEqual([]);
    await settings.screenshot({
      path: testInfo.outputPath("credential-settings.png"),
      fullPage: true,
    });
    expect((await new AxeBuilder({ page: settings }).analyze()).violations).toEqual([]);
  } finally {
    await settings.close();
  }
});

for (const failure of ["deleted", "undecryptable", "rejected"] as const) {
  test(`a ${failure} saved key pauses and permits explicit session-key recovery`, async ({
    page,
  }) => {
    await credentialAccount(page);
    await page.goto("/account/credentials");
    const saved = await saveCredential(
      page,
      "Opponent saved",
      failure === "rejected" ? "expired-fixture" : "match-fixture",
    );
    await page.goto("/");
    await expect(page.getByLabel("Game mode")).toHaveAttribute("aria-disabled", "false");
    await page.getByLabel("Game mode").selectOption("ai_vs_human");
    await configureCredential(page, "Black", { credentialId: saved.credentialId });
    const game = await startCredentialGame(page);
    if (failure === "deleted") {
      expect(
        (
          await page.request.post(API_ORIGIN + "/credentials/revoke", {
            headers: { origin: WEB_ORIGIN },
            data: { credentialId: saved.credentialId },
          })
        ).ok(),
      ).toBe(true);
    } else if (failure === "undecryptable") {
      const identity = (await (
        await page.request.get(API_ORIGIN + "/api/auth/get-session")
      ).json()) as { user: { id: string } };
      const database = integrationDatabase();
      try {
        const rows = await database.db
          .update(providerCredentials)
          .set({ keyId: "unavailable-fixture" })
          .where(
            and(
              eq(providerCredentials.id, saved.credentialId),
              eq(providerCredentials.userId, identity.user.id),
            ),
          )
          .returning({ id: providerCredentials.id });
        expect(rows).toHaveLength(1);
      } finally {
        await database.close();
      }
    }
    await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    await page.locator('[data-square="f2"]').click();
    await page.locator('[data-square="f3"]').click();
    await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
    await expect(page.getByText(/This key is unavailable or was rejected/).first()).toBeVisible();
    const source = page.getByLabel("Black · OpenAI · Credential source");
    await source.selectOption("session");
    await page.getByLabel("Black · OpenAI · API key", { exact: true }).fill("replacement-fixture");
    expect((await readSnapshot(page, game.snapshot.gameId)).moves).toHaveLength(1);
    await page.getByRole("button", { name: "Next move", exact: true }).click();
    await expect
      .poll(async () => (await readSnapshot(page, game.snapshot.gameId)).moves.length)
      .toBe(2);
    expect((await readSnapshot(page, game.snapshot.gameId)).state).toBe("paused");
  });
}

test("account switching clears saved selections and raw keys and fences delayed discovery", async ({
  page,
  context,
  browser,
}) => {
  const otherContext = await browser.newContext();
  await otherContext.addCookies([
    {
      name: "neurochess_test_client",
      value: randomUUID(),
      url: API_ORIGIN,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  const otherPage = await otherContext.newPage();
  let second: Awaited<ReturnType<typeof credentialAccount>>;
  try {
    second = await credentialAccount(otherPage);
  } finally {
    await otherContext.close();
  }
  await credentialAccount(page);
  await page.goto("/account/credentials");
  const saved = await saveCredential(page, "Only first account", "first-account-fixture-1234");
  await page.goto("/");
  const white = page.getByRole("group", { name: "White", exact: true });
  await expect(white.getByLabel("Credential source")).toHaveAttribute("aria-disabled", "false");
  await white.getByLabel("Credential source").selectOption(saved.credentialId);
  await page
    .getByRole("group", { name: "Black", exact: true })
    .getByLabel("API key", { exact: true })
    .fill("old-page-fixture");
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(API_ORIGIN + "/providers/models", async (route) => {
    const response = await route.fetch();
    held.resolve();
    await release.promise;
    await route.fulfill({ response }).catch(() => undefined);
  });
  const switching = await context.newPage();
  try {
    await white.getByRole("button", { name: "Load models", exact: true }).click();
    await held.promise;
    await switching.goto(WEB_ORIGIN + "/auth/sign-in");
    await switching.getByLabel("Email", { exact: true }).fill(second.email);
    await switching.getByLabel("Password", { exact: true }).fill(second.password);
    await switching.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("link", { name: second.username })).toBeVisible();
    release.resolve();
    await page.unrouteAll({ behavior: "wait" });
    await expect(white.getByLabel("Credential source")).toHaveValue("session");
    await expect(white.getByRole("option", { name: /Only first account/ })).toHaveCount(0);
    await expect(white.getByRole("combobox", { name: "Model", exact: true })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(
      page
        .getByRole("group", { name: "Black", exact: true })
        .getByLabel("API key", { exact: true }),
    ).toHaveValue("");
    await switching.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
    await observeCredentialPrivacy(page, ["old-page-fixture", "first-account-fixture-1234"])();
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: "wait" });
    await switching.close();
  }
});

test("credential settings and selectors fit expanded text and remain keyboard accessible", async ({
  page,
}, testInfo) => {
  await credentialAccount(page);
  await page.goto("/account/credentials");
  await saveCredential(page, "A".repeat(64), "long-label-fixture-1234", "openrouter");
  await setPseudoLocalization(page, true);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("main *, header *")]
        .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
        .map((element) => ({
          tag: element.tagName,
          classes: element.className,
          right: element.getBoundingClientRect().right,
        })),
    );
    expect(overflow).toEqual([]);
  }
  await setPseudoLocalization(page, false);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  await page.getByLabel("Label", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("API key", { exact: true })).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("credential-settings-expanded.png"),
    fullPage: true,
  });
});
