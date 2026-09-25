import { randomUUID } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import { gameDetailsSchema } from "@neurochess/contracts";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { API_ORIGIN } from "./environment";
import { expect, test } from "./fixtures";
import { expectUnbrokenWords, setPseudoLocalization } from "./text-layout";

const password = "browser-fixture password";
const nextPassword = "replacement-fixture password";
test.use({ allowIdentityLoss: true });
const unique = () => "Player_" + randomUUID().replaceAll("-", "").slice(0, 12);
async function signIn(page: Page, email: string, secret = password) {
  await page.goto("/auth/sign-in");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
async function emailLink(page: Page, email: string, kind: "verification" | "reset") {
  const response = await page.request.post(API_ORIGIN + "/__test__/mail", {
    data: { email, kind },
  });
  return z.object({ url: z.url() }).parse(await response.json()).url;
}
async function register(page: Page, email: string) {
  await page.goto("/auth/sign-up");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByText(/If this address can be registered/, { exact: false })).toBeVisible();
}
async function onboard(page: Page, username: string) {
  await expect(page.getByRole("heading", { name: "Choose your arena identity" })).toBeVisible();
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("heading", { name: "Set up a game" })).toBeVisible();
}

test("email journey, profile, account game, sign-out and paused recovery", async ({
  page,
  context,
}, testInfo) => {
  const email = randomUUID() + "@example.test";
  const username = unique();
  let bootstraps = 0;
  let turns = 0;
  let badAccountHeaders = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/guest-session")) bootstraps++;
    if (request.url().endsWith("/ai-turn")) turns++;
    if (
      /\/(games|providers)(\/|$)/.test(new URL(request.url()).pathname) &&
      request.headers()["x-neurochess-identity"] !== "account"
    ) {
      badAccountHeaders++;
    }
  });
  await register(page, email);
  await signIn(page, email);
  await expect(page.getByRole("alert")).toContainText("Verify your email before signing in");
  await page.getByRole("link", { name: "Resend verification email" }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Send verification email" }).click();
  await expect(page.getByText(/If this address needs verification/)).toBeVisible();
  const verification = await emailLink(page, email, "verification");
  await page.goto(verification);
  await expect(page.getByRole("button", { name: "Verify email" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.getByText("Email verified. You can now sign in.")).toBeVisible();
  await signIn(page, email);
  await onboard(page, username);
  await page.getByRole("link", { name: username, exact: true }).click();
  await page.getByLabel("Username", { exact: true }).fill(username + "_2");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved.", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Back to Arena" }).click();
  await page.getByLabel("Game mode").selectOption("ai_vs_human");
  const ai = page.getByRole("group", { name: "Black", exact: true });
  await ai.getByLabel("API key", { exact: true }).fill("account-game-fixture");
  await ai.getByRole("button", { name: "Load models", exact: true }).click();
  const model = ai.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveAttribute("aria-disabled", "false");
  await model.fill("model-a");
  await model.press("ArrowDown");
  await model.press("Enter");
  const creation = page.waitForResponse(
    (response) => response.url() === API_ORIGIN + "/games" && response.status() === 201,
  );
  await page.getByRole("button", { name: "Start game", exact: true }).click();
  const game = gameDetailsSchema.parse(await (await creation).json());
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  await page.locator('[data-square="f2"]').click();
  await page.locator('[data-square="f3"]').click();
  await expect.poll(() => turns).toBe(1);
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByText(/You are signed out or your session has ended/)).toBeVisible();
  await expect(page.getByRole("grid")).toHaveCount(0);
  await expect(page.getByText(username + "_2", { exact: true })).toHaveCount(0);
  await signIn(page, email);
  await page.getByRole("button", { name: "Return to game" }).click();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(page.getByLabel("Black · OpenAI · API key", { exact: true })).toHaveValue("");
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
  expect(turns).toBe(1);
  expect(bootstraps).toBe(0);
  expect(badAccountHeaders).toBe(0);
  expect(new URL(page.url()).searchParams.get("game")).toBe(game.snapshot.gameId);

  const other = await context.newPage();
  await other.goto("/auth/forgot-password");
  await other.getByLabel("Email", { exact: true }).fill(email);
  await other.getByRole("button", { name: "Send reset email" }).click();
  await expect(other.getByText(/A reset email has been submitted/)).toBeVisible();
  const reset = await emailLink(other, email, "reset");
  await other.goto(reset);
  await other.getByLabel("New password", { exact: true }).fill(nextPassword);
  await other.getByRole("button", { name: "Save new password" }).click();
  await expect(other.getByText(/All previous sessions have been revoked/)).toBeVisible();
  await expect(page.getByRole("grid")).toHaveCount(0);
  await expect(page.getByText(/You are signed out or your session has ended/)).toBeVisible();
  await other.goto(reset);
  await other.getByLabel("New password", { exact: true }).fill(nextPassword);
  await other.getByRole("button", { name: "Save new password" }).click();
  await expect(
    other.getByText(/This link is missing, invalid, expired, or already used/),
  ).toBeVisible();
  await other.close();
  await signIn(page, email, nextPassword);
  await page.getByRole("button", { name: "Return to game" }).click();
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
  await page.screenshot({ path: testInfo.outputPath("account-recovery.png"), fullPage: true });
  const leaked = await page.evaluate(() =>
    /example\.test|account-game-fixture|browser-fixture|replacement-fixture/.test(
      JSON.stringify(localStorage) +
        JSON.stringify(sessionStorage) +
        JSON.stringify(history.state) +
        location.href,
    ),
  );
  expect(leaked).toBe(false);
});

for (const provider of ["google", "github"] as const) {
  test(`${provider} fixture sign-in, profile avatar removal and callback failure`, async ({
    page,
  }) => {
    const email = randomUUID() + "@example.test";
    let failure = false;
    await page.route(
      provider === "google"
        ? "https://accounts.google.com/o/oauth2/v2/auth**"
        : "https://github.com/login/oauth/authorize**",
      async (route) => {
        const response = await page.request.post(API_ORIGIN + "/__test__/oauth", {
          data: { provider, authorization: route.request().url(), email, failure },
        });
        const { url } = z.object({ url: z.url() }).parse(await response.json());
        await route.fulfill({ status: 302, headers: { location: url } });
      },
    );
    await page.route("https://*.googleusercontent.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: "invalid-fixture-image" }),
    );
    await page.route("https://avatars.githubusercontent.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: "invalid-fixture-image" }),
    );
    await page.goto("/auth/sign-in");
    const providerName = provider === "google" ? "Google" : "GitHub";
    await page.getByRole("button", { name: "Continue with " + providerName }).click();
    await expect(page.getByRole("link", { name: "Continue to Arena" })).toBeVisible();
    expect(new URL(page.url()).hash).toBe("");
    await page.getByRole("link", { name: "Continue to Arena" }).click();
    const username = unique();
    await onboard(page, username);
    await page.getByRole("link", { name: username, exact: true }).click();
    await page.getByLabel("Use initials (remove provider avatar)").check();
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText("Profile saved.", { exact: true }).first()).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Use initials (remove provider avatar)")).toBeChecked();
    await expect(page.locator("img")).toHaveCount(0);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    failure = true;
    await page.goto("/auth/sign-in");
    await page.getByRole("button", { name: "Continue with " + providerName }).click();
    await expect(page.getByRole("alert")).toContainText("was canceled or could not be completed");
    expect(new URL(page.url()).hash).toBe("");
  });
}

test("account forms support keyboard, password paste, long copy and missing links", async ({
  page,
}, testInfo) => {
  // Title focus precedes method discovery; hold every request because Strict Mode can replay it.
  const methods = Promise.withResolvers<void>();
  await page.route("**/api/auth/methods", async (route) => {
    await methods.promise;
    await route.continue();
  });
  await page.goto("/auth/sign-up?returnTo=https://untrusted.test/#token=discard-me");
  const heading = page.getByRole("heading", { name: "Create your account" });
  const email = page.getByLabel("Email", { exact: true });
  try {
    await expect(heading).toBeFocused();
    await expect(email).toHaveCount(0);
  } finally {
    methods.resolve();
  }
  await expect(email).toBeVisible();
  await expect(heading).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(email).toBeFocused();
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "autocomplete",
    "new-password",
  );
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await expectUnbrokenWords(page.getByRole("button"));
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await setPseudoLocalization(page, true);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expectUnbrokenWords(page.getByRole("button"));
    const emailBox = await page.locator('input[name="email"]').boundingBox();
    const passwordBox = await page.locator('input[name="password"]').boundingBox();
    expect(passwordBox?.width ?? 0).toBeGreaterThanOrEqual(Math.min(160, emailBox?.width ?? 160));
  }
  await page.setViewportSize(testInfo.project.use.viewport!);
  await page.screenshot({ path: testInfo.outputPath("account-long-copy.png"), fullPage: true });
  await page.goto("/auth/reset-password");
  await expect(
    page.getByText(/This link is missing, invalid, expired, or already used/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save new password" })).toHaveCount(0);
});
