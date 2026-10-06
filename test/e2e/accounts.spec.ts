import { randomUUID } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { createAccount } from "./account-helpers";
import { observeCredentialPrivacy } from "./credential-privacy";
import { API_ORIGIN } from "./environment";
import { expect, submitGame, test } from "./fixtures";
import { setPseudoLocalization } from "./text-layout";

const password = "browser account fixture 🌙";
const newPassword = "replacement account fixture 🌙";
const emailFor = () => `${randomUUID()}@example.com`;
const usernameFor = () => "Player_" + randomUUID().slice(0, 8);

async function emailLink(page: Page, email: string, kind: "verification" | "reset") {
  let link = "";
  await expect
    .poll(async () => {
      const response = await page.request.post(API_ORIGIN + "/__test__/mail", {
        data: { email, kind },
      });
      if (response.status() !== 200) return false;
      const body = (await response.json()) as { link: string | null };
      link = body.link ?? "";
      return Boolean(link);
    })
    .toBe(true);
  return link;
}
async function login(page: Page, email: string, value = password, destination = "/") {
  await page.goto("/auth/sign-in?returnTo=" + encodeURIComponent(destination));
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(value);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
async function register(page: Page, email: string) {
  await page.goto("/auth/sign-up");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByText(/Request received/)).toBeVisible();
  await page.goto(await emailLink(page, email, "verification"));
  await expect(page.getByText("Email verified. Sign in to continue.")).toBeVisible();
  // Sign in on the verification landing itself, as a user following the email link would.
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choose your username" })).toBeVisible();
  await expect(page.getByText("Email verified. Sign in to continue.")).toHaveCount(0);
  const username = usernameFor();
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.evaluate(() => {
    Object.assign(window, { onboardingSentinel: "same-document" });
  });
  await page.getByRole("button", { name: "Finish profile", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Set up a game" })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "onboardingSentinel") as unknown)).toBe(
    "same-document",
  );
  return username;
}
async function startAccountGame(page: Page) {
  await expect(page.getByLabel("Game mode")).toHaveAttribute("aria-disabled", "false");
  await page.getByLabel("Game mode").selectOption("ai_vs_human");
  const seat = page.getByRole("group", { name: "Black", exact: true });
  await seat.getByLabel("API key", { exact: true }).fill("match-fixture");
  await seat.getByRole("button", { name: "Load models", exact: true }).click();
  const model = seat.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveAttribute("aria-disabled", "false");
  await model.fill("model-a");
  await model.press("ArrowDown");
  await model.press("Enter");
  const { response, details } = await submitGame(page);
  expect(response.request().headers()["x-neurochess-identity"]).toBe("account");
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  return details.snapshot.gameId;
}

test("email registration, profile, account play, sign-out, paused return and password reset", async ({
  page,
  context,
}) => {
  const email = emailFor();
  const privateState = observeCredentialPrivacy(page, [
    email,
    password,
    newPassword,
    "match-fixture",
  ]);
  let bootstraps = 0;
  page.on("request", (request) => {
    if (request.url() === API_ORIGIN + "/guest-session") bootstraps++;
  });
  const username = await register(page, email);
  const gameId = await startAccountGame(page);
  await page.locator('[data-square="f2"]').click();
  await page.locator('[data-square="f3"]').click();
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  await expect(page.getByRole("grid")).toHaveCount(0);
  await login(page, email, password, "/games/" + gameId);
  await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
  await expect(page.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
  await expect(page.getByRole("link", { name: username })).toBeVisible();
  expect(bootstraps).toBe(0);
  await privateState();

  const resetPage = await context.newPage();
  await resetPage.goto("/auth/forgot-password");
  await resetPage.getByLabel("Email", { exact: true }).fill(email);
  await resetPage.getByRole("button", { name: "Request reset link" }).click();
  await expect(resetPage.getByText(/Request received/)).toBeVisible();
  const resetLink = await emailLink(resetPage, email, "reset");
  await resetPage.goto(resetLink);
  await expect.poll(() => new URL(resetPage.url()).hash).toBe("");
  await resetPage.getByLabel("Password", { exact: true }).fill(newPassword);
  await resetPage.getByRole("button", { name: "Set new password" }).click();
  await expect(resetPage.getByText(/Password updated/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  await expect(page.getByRole("grid")).toHaveCount(0);
  await resetPage.close();
  await login(page, email, newPassword, "/games/" + gameId);
  await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
  await page.goto(resetLink);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByRole("alert")).toContainText(/invalid or has expired/);
});

test("other tabs observe onboarding and profile edits without losing keys or pausing a game", async ({
  page,
  context,
}) => {
  const email = emailFor();
  await page.goto("/auth/sign-up");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByText(/Request received/)).toBeVisible();
  await page.goto(await emailLink(page, email, "verification"));
  await login(page, email);
  await expect(page.getByRole("heading", { name: "Choose your username" })).toBeVisible();
  const observer = await context.newPage();
  try {
    await observer.goto("/");
    await expect(observer.getByRole("heading", { name: "Choose your username" })).toBeVisible();
    await page.getByLabel("Username", { exact: true }).fill(usernameFor());
    await page.getByRole("button", { name: "Finish profile" }).click();
    await expect(observer.getByRole("heading", { name: "Set up a game" })).toBeVisible();
    const key = observer
      .getByRole("group", { name: "White", exact: true })
      .getByLabel("API key", { exact: true });
    await expect(key).toBeEditable();
    await key.fill("profile-key-fixture");
    await page.goto("/account");
    const firstRename = usernameFor();
    await page.getByLabel("Username", { exact: true }).fill(firstRename);
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText("Profile saved.", { exact: true })).toBeVisible();
    await expect(observer.getByRole("link", { name: firstRename, exact: true })).toBeVisible();
    await expect(key).toHaveValue("profile-key-fixture");
    const gameId = await startAccountGame(observer);
    const renamed = usernameFor();
    await page.getByLabel("Username", { exact: true }).fill(renamed);
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(observer.getByRole("link", { name: renamed, exact: true })).toBeVisible();
    await expect(observer.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    const game = await observer.request.get(`${API_ORIGIN}/games/${gameId}`);
    expect(((await game.json()) as { state: string }).state).toBe("active");
  } finally {
    await observer.close();
  }
});

test("a stale Sign out cannot revoke the replacement account cookie", async ({
  page,
  context,
  newContext,
}) => {
  const otherContext = await newContext();
  const replacementAccount = await createAccount(otherContext.request);
  const replacementCookies = (await otherContext.cookies(API_ORIGIN)).filter(
    (cookie) => cookie.name !== "neurochess_test_client",
  );
  const replacement = await otherContext.request.get(API_ORIGIN + "/api/auth/get-session");
  const replacementId = ((await replacement.json()) as { user: { id: string } }).user.id;
  await otherContext.close();
  const originalAccount = await createAccount(page.request);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Set up a game" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: originalAccount.username, exact: true }),
  ).toBeVisible();
  const original = await page.request.get(API_ORIGIN + "/api/auth/get-session");
  const originalId = ((await original.json()) as { user: { id: string } }).user.id;
  const release = Promise.withResolvers<void>();
  await page.route(API_ORIGIN + "/api/auth/get-session", async (route) => {
    await release.promise;
    await route.continue();
  });
  try {
    await context.addCookies(replacementCookies);
    const signOut = page.waitForResponse(API_ORIGIN + "/api/auth/sign-out");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    const rejected = await signOut;
    expect(rejected.status()).toBe(401);
    expect(rejected.request().headers()["x-neurochess-expected-account"]).toBe(originalId);
    release.resolve();
    await expect(
      page.getByRole("link", { name: replacementAccount.username, exact: true }),
    ).toBeVisible();
    const remaining = await page.request.get(API_ORIGIN + "/api/auth/get-session");
    expect(((await remaining.json()) as { user: { id: string } }).user.id).toBe(replacementId);
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("a second tab switches accounts during discovery and discards the old page's secrets and late result", async ({
  page,
  context,
  newContext,
}) => {
  const otherContext = await newContext();
  const secondAccount = await createAccount(otherContext.request);
  await otherContext.close();
  const firstAccount = await createAccount(page.request);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Set up a game" })).toBeVisible();
  await expect(page.getByRole("link", { name: firstAccount.username, exact: true })).toBeVisible();
  let discoveryHeld = false;
  const release = Promise.withResolvers<void>();
  await page.route(API_ORIGIN + "/providers/models", async (route) => {
    const response = await route.fetch();
    discoveryHeld = true;
    await release.promise;
    await route.fulfill({ response });
  });
  let switching: Page | undefined;
  try {
    const seat = page.getByRole("group", { name: "White", exact: true });
    await seat.getByLabel("API key", { exact: true }).fill("obsolete-key-canary");
    await seat.getByRole("button", { name: "Load models", exact: true }).click();
    await expect
      .poll(() => discoveryHeld, {
        message: "Discovery response is held before switching accounts",
      })
      .toBe(true);
    switching = await context.newPage();
    await login(switching, secondAccount.email, secondAccount.password);
    await expect(switching.getByRole("heading", { name: "Set up a game" })).toBeVisible();
    await expect(page.getByRole("link", { name: secondAccount.username })).toBeVisible();
    release.resolve();
    await page.unrouteAll({ behavior: "wait" });
    await expect(page.getByRole("link", { name: firstAccount.username })).toHaveCount(0);
    await expect(seat.getByLabel("API key", { exact: true })).toHaveValue("");
    await expect(seat.getByRole("combobox", { name: "Model", exact: true })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await switching.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
    await page.getByRole("button", { name: "Continue as guest", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Set up a game" })).toBeVisible();
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: "wait" });
    await switching?.close();
  }
});

test("unverified sign-in offers resend, a verified profile can be renamed, and cookie loss requires explicit guest play", async ({
  page,
  context,
}) => {
  const email = emailFor();
  await page.goto("/auth/sign-up");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText(/Request received/)).toBeVisible();
  await login(page, email);
  await expect(page.getByRole("alert")).toContainText(/Verify your email/);
  await page.getByRole("link", { name: "Resend verification link" }).click();
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Request verification link" }).click();
  await expect(page.getByText(/Request received/)).toBeVisible();
  await page.goto(await emailLink(page, email, "verification"));
  await login(page, email);
  await expect(page.getByRole("heading", { name: "Choose your username" })).toBeVisible();
  await page.getByLabel("Username", { exact: true }).fill(usernameFor());
  await page.getByRole("button", { name: "Finish profile" }).click();
  await expect(page.getByRole("heading", { name: "Set up a game" })).toBeVisible();
  await page.goto("/account");
  const renamed = usernameFor();
  await page.getByLabel("Username", { exact: true }).fill(renamed);
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: renamed })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await context.clearCookies({ name: /^(?!neurochess_test_client$)/ });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
  await expect(page.getByLabel("Username", { exact: true })).toHaveCount(0);
});

for (const provider of ["google", "github"] as const) {
  test(`${provider} OAuth completes real session/profile onboarding and handles canceled consent`, async ({
    page,
  }) => {
    const email = emailFor();
    const upstream =
      provider === "google"
        ? "https://accounts.google.com/**"
        : "https://github.com/login/oauth/authorize**";
    let cancel = false;
    await page.route(upstream, async (route) => {
      const response = await page.request.post(API_ORIGIN + "/__test__/oauth", {
        data: { provider, url: route.request().url(), email, cancel },
      });
      expect(response.ok()).toBe(true);
      const callback = (await response.json()) as { url: string };
      await route.fulfill({ status: 302, headers: { location: callback.url }, body: "" });
    });
    await page.context().route("https://*.googleusercontent.com/**", (route) => route.abort());
    await page
      .context()
      .route("https://avatars.githubusercontent.com/**", (route) => route.abort());
    await page.goto("/auth/sign-in");
    await page
      .getByRole("button", {
        name: provider === "google" ? "Continue with Google" : "Continue with GitHub",
      })
      .click();
    await expect(page.getByRole("heading", { name: "Choose your username" })).toBeVisible();
    const observer = await page.context().newPage();
    await observer.goto("/");
    await expect(observer.getByRole("button", { name: "Remove avatar" })).toBeVisible();
    await page.getByRole("button", { name: "Remove avatar" }).click();
    await expect(page.getByRole("button", { name: "Remove avatar" })).toHaveCount(0);
    await expect(observer.getByRole("button", { name: "Remove avatar" })).toHaveCount(0);
    await observer.close();
    await page.getByLabel("Username", { exact: true }).fill(usernameFor());
    await page.getByRole("button", { name: "Finish profile" }).click();
    await expect(page.getByRole("heading", { name: "Set up a game" })).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sign in to continue" })).toBeVisible();
    cancel = true;
    await page.goto("/auth/sign-in");
    await page
      .getByRole("button", {
        name: provider === "google" ? "Continue with Google" : "Continue with GitHub",
      })
      .click();
    await expect(page.getByRole("alert")).toContainText(/cancelled/);
    expect(new URL(page.url()).search).toBe("");
  });
}

test("account forms support keyboard, enlarged copy, mobile layout and invalid verification recovery", async ({
  page,
}) => {
  await page.goto(API_ORIGIN + "/api/auth/verify-email?token=expired-fixture");
  await expect(page.getByRole("alert")).toContainText(/invalid or has expired/);
  expect(new URL(page.url()).search).toBe("");
  await page.getByRole("link", { name: "Resend verification link", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email", { exact: true })).toBeFocused();
  await page.goto("/auth/sign-up");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByLabel("Password", { exact: true }).fill("revealed-fixture-password");
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "text");
  await page.getByLabel("Password", { exact: true }).clear();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "Show password" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await setPseudoLocalization(page, true);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByLabel(/^Email/)).toBeVisible();
});
