import { randomUUID } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import { gameDetailsSchema } from "@neurochess/contracts";

import { createAccount } from "./account-helpers";
import { observeCredentialPrivacy } from "./credential-privacy";
import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, test } from "./fixtures";

test("account deletion confirms full scope, clears another tab and rejects old private URLs", async ({
  page,
  context,
}) => {
  const owner = await createAccount(page.request);
  const credentialId = randomUUID();
  const headers = { origin: WEB_ORIGIN };
  expect(
    (
      await page.request.post(API_ORIGIN + "/credentials", {
        headers,
        data: {
          credentialId,
          provider: "openai",
          label: "Deletion fixture",
          apiKey: "saved-deletion-canary",
          save: true,
        },
      })
    ).status(),
  ).toBe(201);
  const observer = await context.newPage();
  const privacy = observeCredentialPrivacy(observer, ["page-deletion-canary"]);
  await observer.goto("/");
  const key = observer
    .getByRole("group", { name: "White", exact: true })
    .getByLabel("API key", { exact: true });
  await key.fill("page-deletion-canary");
  const created = await page.request.post(API_ORIGIN + "/games", {
    headers,
    data: {
      mode: "ai_vs_human",
      seats: {
        white: { type: "human" },
        black: { type: "ai", provider: "openai", modelId: "model-a", parameters: {} },
      },
    },
  });
  expect(created.status()).toBe(201);
  const game = gameDetailsSchema.parse(await created.json()).snapshot.gameId;
  await page.goto("/account");
  const trigger = page.getByRole("button", { name: "Delete account", exact: true });
  await trigger.click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await expect(dialog).toContainText("unfinished games");
  await expect(dialog).toContainText("external backups");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Permanently delete account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Account deleted", exact: true })).toBeFocused();
  await expect(
    observer.getByRole("heading", { name: "Sign in to continue", exact: true }),
  ).toBeVisible();
  await expect(key).toHaveCount(0);
  await expect(observer.getByRole("link", { name: owner.username, exact: true })).toHaveCount(0);
  for (const suffix of ["", "/details", "/replay", "/pgn", "/invocations"]) {
    expect(
      (
        await page.request.get(`${API_ORIGIN}/games/${game}${suffix}`, {
          headers: { "x-neurochess-identity": "account" },
        })
      ).status(),
    ).toBe(401);
  }
  expect((await page.request.get(API_ORIGIN + "/credentials")).status()).toBe(401);
  expect(await (await page.request.get(API_ORIGIN + "/api/auth/get-session")).json()).toBeNull();
  await privacy();
  await observer.close();
  await page.goto("/games/" + game);
  await expect(
    page.getByRole("heading", { name: "Sign in to continue", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("grid")).toHaveCount(0);
});

test("a lost deletion response reports uncertainty without retrying or claiming success", async ({
  page,
}) => {
  await createAccount(page.request);
  await page.goto("/account");
  let requests = 0;
  await page.route(API_ORIGIN + "/api/auth/delete-account", async (route) => {
    requests++;
    expect((await route.fetch()).status()).toBe(200);
    // A valid but lost acknowledgement exercises the same safe client error path
    // without storing credential-bearing network traces or console errors.
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.getByRole("button", { name: "Delete account", exact: true }).click();
  await page.getByRole("button", { name: "Permanently delete account", exact: true }).click();
  await expect(page.getByText(/We could not confirm account deletion/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account deleted", exact: true })).toHaveCount(0);
  expect(await (await page.request.get(API_ORIGIN + "/api/auth/get-session")).json()).toBeNull();
  expect(requests).toBe(1);
});
