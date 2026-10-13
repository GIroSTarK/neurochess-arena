import { type AiProvider, credentialMetadataSchema } from "@neurochess/contracts";
import type { Page } from "@playwright/test";

import { API_ORIGIN } from "./environment";
import { expect, submitGame } from "./fixtures";

export async function saveCredential(
  page: Page,
  label: string,
  apiKey: string,
  provider: AiProvider = "openai",
) {
  await page.getByLabel("Provider", { exact: true }).selectOption(provider);
  await page.getByLabel("Label", { exact: true }).fill(label);
  await page.getByLabel("API key", { exact: true }).fill(apiKey);
  const optIn = page.getByRole("checkbox", { name: "Save this key to my account" });
  await expect(optIn).not.toBeChecked();
  await optIn.check();
  const saving = page.waitForResponse(
    (response) =>
      response.url() === API_ORIGIN + "/credentials" && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save key", exact: true }).click();
  const response = await saving;
  expect(response.status()).toBe(201);
  const result = credentialMetadataSchema.parse(await response.json());
  await expect(page.getByText(label, { exact: true })).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(optIn).not.toBeChecked();
  return result;
}

export async function configureCredential(
  page: Page,
  color: "White" | "Black",
  source: { credentialId: string } | { apiKey: string },
  provider: AiProvider = "openai",
) {
  const seat = page.getByRole("group", { name: color, exact: true });
  await expect(seat.getByLabel("Provider", { exact: true })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await seat.getByLabel("Provider", { exact: true }).selectOption(provider);
  if ("credentialId" in source) {
    await expect(
      seat
        .getByRole("option", { includeHidden: true })
        .filter({ hasText: /Ends in/ })
        .first(),
    ).toBeAttached();
    await seat.getByLabel("Credential source").selectOption(source.credentialId);
    await expect(seat.getByLabel("API key", { exact: true })).toHaveCount(0);
  } else {
    await expect(seat.getByLabel("Credential source")).toHaveValue("session");
    await seat.getByLabel("API key", { exact: true }).fill(source.apiKey);
  }
  await seat.getByRole("button", { name: "Load models", exact: true }).click();
  const model = seat.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveAttribute("aria-disabled", "false");
  await model.fill("model-a");
  await model.press("ArrowDown");
  await model.press("Enter");
}

export async function startCredentialGame(page: Page) {
  const { details: game } = await submitGame(page);
  await expect(page.getByRole("grid")).toBeVisible();
  return game;
}
