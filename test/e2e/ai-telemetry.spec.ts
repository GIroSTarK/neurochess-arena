import AxeBuilder from "@axe-core/playwright";
import { gameInvocationsSchema } from "@neurochess/contracts";
import type { Page } from "@playwright/test";

import { API_ORIGIN } from "./environment";
import { expect, test } from "./fixtures";
import { setPseudoLocalization } from "./text-layout";

async function start(page: Page, key: string) {
  await page.goto("/");
  for (const color of ["White", "Black"]) {
    const seat = page.getByRole("group", { name: color, exact: true });
    await expect(seat.getByLabel("Provider", { exact: true })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    await seat.getByLabel("API key", { exact: true }).fill(key);
    await seat.getByRole("button", { name: "Load models", exact: true }).click();
    const model = seat.getByRole("combobox", { name: "Model", exact: true });
    await expect(model).toHaveAttribute("aria-disabled", "false");
    await model.fill("model-a");
    await model.press("ArrowDown");
    await model.press("Enter");
  }
  await page.getByRole("button", { name: "Start game", exact: true }).click();
  await expect(page).toHaveURL(/\?game=/);
  return new URL(page.url()).searchParams.get("game")!;
}

test("accepted-move commentary and measured telemetry follow replay; Events includes retries and incomplete totals", async ({
  page,
}, testInfo) => {
  const gameId = await start(page, "telemetry-fixture");
  await page.getByLabel("Delay between moves").selectOption("500");
  await expect(page.getByRole("heading", { name: "Black wins by checkmate" })).toBeVisible();
  const totals = page.getByRole("region", { name: "Operational totals" });
  await expect(totals.getByText("Recorded attempts: 6", { exact: true })).toBeVisible();
  await expect(totals.getByText("Unavailable", { exact: true })).toHaveCount(3);
  await expect(totals.getByText("Reported for 3 of 6 attempts", { exact: true })).toHaveCount(3);
  const response = await page.request.get(`${API_ORIGIN}/games/${gameId}/invocations`);
  const records = gameInvocationsSchema.parse(await response.json());
  const commentary = page.getByRole("region", { name: "Commentary & move details" });
  await expect(commentary.getByText("No commentary provided", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "First", exact: true }).click();
  await expect(commentary.getByText("Initial position · no move selected.")).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    commentary.getByText('<img src=x onerror="alert(1)"> **Viewer note**', { exact: true }),
  ).toBeVisible();
  await expect(commentary.locator("img, script, strong")).toHaveCount(0);
  await expect(
    commentary.getByText(`${records.turns[0]!.attempts[2]!.durationMs!.toLocaleString("en")} ms`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(commentary.getByText("0", { exact: true })).toHaveCount(3);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(commentary.getByText("No commentary provided", { exact: true })).toBeVisible();
  await expect(commentary.getByText("Unavailable", { exact: true })).toHaveCount(3);
  const movesTab = page.getByRole("tab", { name: "Moves", exact: true });
  await movesTab.focus();
  await movesTab.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Events", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  const events = page.getByRole("tabpanel", { name: "Events", exact: true });
  await expect(events.getByText("Invalid responses: 2 of 3", { exact: true })).toBeVisible();
  await expect(events.getByText("Attempt 3 · Move accepted", { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).include("#arena-match").analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("telemetry-replay.png"), fullPage: true });
  await setPseudoLocalization(page, true);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("button", { name: /^Refresh details/ }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: /^Refresh details/ })).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath("telemetry-expanded.png"), fullPage: true });
});

test("provider pause keeps the invalid budget and attempt history through manual retry and stopped replay", async ({
  page,
}, testInfo) => {
  const gameId = await start(page, "retry-fixture");
  await expect(page.getByRole("heading", { name: "Game paused", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Events", exact: true }).click();
  const events = page.getByRole("tabpanel", { name: "Events", exact: true });
  await expect(events.getByText("Invalid responses: 1 of 3", { exact: true })).toBeVisible();
  await expect(events.getByText("Attempt 2 · Provider failure", { exact: true })).toBeVisible();
  await expect(events.getByText("Paused for user-directed retry.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Change API keys", exact: true }).click();
  await page.getByLabel("White · OpenAI · API key", { exact: true }).fill("match-fixture");
  await page.getByRole("button", { name: "Next move", exact: true }).click();
  await expect(events.getByText("Attempt 3 · Move accepted", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "Stop game", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Game stopped", exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Commentary & move details" })
      .getByText("No commentary provided", { exact: true }),
  ).toBeVisible();
  const previousUrl = page.url();
  const pgn = await page.request.get(`${API_ORIGIN}/games/${gameId}/pgn`);
  expect(pgn.status()).toBe(200);
  await page.getByRole("button", { name: "New game", exact: true }).click();
  await start(page, "slow-fixture");
  await page.goto(previousUrl);
  await expect(page.getByRole("heading", { name: "Game stopped", exact: true })).toBeVisible();
  const totals = page.getByRole("region", { name: "Operational totals" });
  await expect(totals.getByText("Recorded attempts: 3", { exact: true })).toBeVisible();
  expect(await (await page.request.get(`${API_ORIGIN}/games/${gameId}/pgn`)).json()).toEqual(
    await pgn.json(),
  );
  await page.route("**/invocations", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.getByRole("button", { name: "Refresh details", exact: true }).click();
  await expect(totals.getByText(/Telemetry could not be loaded/)).toBeVisible();
  await page.unroute("**/invocations");
  await page.getByRole("button", { name: "Refresh details", exact: true }).click();
  await expect(totals.getByText("Recorded attempts: 3", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("telemetry-aborted.png"), fullPage: true });
});
