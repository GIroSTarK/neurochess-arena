import { tmpdir } from "node:os";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { aiGameResponseSchema, gameSnapshotSchema } from "@neurochess/contracts";
import type { Page } from "@playwright/test";

import { API_ORIGIN } from "./environment";
import { expect, readSnapshot, test } from "./fixtures";

type Mode = "ai_vs_ai" | "white" | "black";

async function start(page: Page, mode: Mode, key = "fixture-recovery") {
  await page.goto("/");
  if (mode !== "ai_vs_ai") {
    await page.getByRole("radio", { name: /AI vs human/ }).check();
    await page
      .getByRole("group", { name: "Your color" })
      .getByRole("radio", { name: mode === "white" ? "White" : "Black", exact: true })
      .check();
  }
  const colors = mode === "ai_vs_ai" ? ["White", "Black"] : [mode === "white" ? "Black" : "White"];
  for (const color of colors) {
    const panel = page.getByRole("region", { name: `${color} configuration` });
    const provider = panel.getByRole("combobox", { name: "Provider" });
    await expect(provider).toHaveAttribute("aria-disabled", "false");
    await provider.selectOption("openai");
    await panel.getByLabel("API key", { exact: true }).fill(key);
    await panel.getByRole("button", { name: "Load models" }).click();
    const picker = panel.getByRole("combobox", { name: "Model", exact: true });
    await picker.fill("Fixture full");
    await picker.press("ArrowDown");
    await picker.press("Enter");
    await panel.getByText("Advanced parameters", { exact: true }).click();
    await panel
      .getByRole("spinbutton", { name: "Temperature" })
      .fill(color === "White" ? "0" : "1.5");
  }
  const creation = page.waitForResponse((response) => response.url() === API_ORIGIN + "/ai/games");
  await page.getByRole("button", { name: "Start game" }).click();
  return gameSnapshotSchema.parse(await (await creation).json());
}

async function cycle(page: Page, mode: Mode, gameId: string, startPly: number) {
  if (mode === "ai_vs_ai") {
    await expect
      .poll(async () => (await readSnapshot(page, gameId)).moves.length)
      .toBe(startPly + 4);
    return;
  }
  const moves = mode === "white" ? ["g1f3", "f3g1"] : ["g8f6", "f6g8"];
  for (const [index, move] of moves.entries()) {
    const before = startPly + index * 2 + (mode === "black" ? 1 : 0);
    await expect.poll(async () => (await readSnapshot(page, gameId)).moves.length).toBe(before);
    const origin = page.locator(`[data-square="${move.slice(0, 2)}"]`);
    await expect(origin).not.toHaveAttribute("aria-disabled", "true");
    await origin.click();
    await page.locator(`[data-square="${move.slice(2)}"]`).click();
  }
  await expect.poll(async () => (await readSnapshot(page, gameId)).moves.length).toBe(startPly + 4);
}

async function enterKeys(page: Page, mode: Mode) {
  await page.getByRole("button", { name: "Enter missing keys" }).click();
  const dialog = page.getByRole("dialog", { name: "Re-enter your API keys" });
  const colors = mode === "ai_vs_ai" ? ["White", "Black"] : [mode === "white" ? "Black" : "White"];
  await expect(dialog.locator("input")).toHaveCount(colors.length);
  for (const color of colors) {
    const field = dialog.getByLabel(`${color} · openai API key`);
    await expect(field).toHaveValue("");
    await expect(field).toHaveAttribute("type", "password");
    await expect(dialog.getByRole("button", { name: "Use keys for this page" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await field.fill("fixture-recovery");
  }
  await dialog.getByRole("button", { name: "Use keys for this page" }).click();
}

for (const mode of ["ai_vs_ai", "white", "black"] as const) {
  test(`refresh restores ${mode} configuration and draw history; keys and continuation are explicit`, async ({
    page,
  }, info) => {
    let turns = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/ai-turn")) turns++;
    });
    const initial = await start(page, mode);
    await cycle(page, mode, initial.gameId, 0);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    const before = await readSnapshot(page, initial.gameId);
    expect(before.moves).toHaveLength(4);
    const configuration = aiGameResponseSchema.parse(
      await (await page.request.get(`${API_ORIGIN}/ai/games/${initial.gameId}`)).json(),
    ).configuration;
    const beforeRefresh = turns;
    await page.reload();
    await page.getByRole("button", { name: "Return to game" }).click();
    await expect(page).toHaveTitle(
      `${mode === "ai_vs_ai" ? "AI vs AI" : "AI vs human"} · Neurochess Arena`,
    );
    await expect(page.getByText("Game paused", { exact: true })).toBeVisible();
    await expect(page.getByRole("grid", { name: "Chessboard" })).toBeVisible();
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    const restored = aiGameResponseSchema.parse(
      await (await page.request.get(`${API_ORIGIN}/ai/games/${initial.gameId}`)).json(),
    );
    expect(restored.configuration).toEqual(configuration);
    expect(restored.snapshot).toMatchObject({
      state: "paused",
      moves: before.moves,
      fen: before.fen,
      pgn: before.pgn,
    });
    expect(restored.snapshot.version).toBeGreaterThan(before.version);
    const resume = page.getByRole("button", { name: "Resume", exact: true });
    await expect(resume).toHaveAttribute("aria-disabled", "true");
    if (mode === "ai_vs_ai") {
      await expect(page.getByRole("button", { name: "Next move" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    }
    await page.getByRole("button", { name: "Enter missing keys" }).click();
    await expect(page.getByRole("dialog").locator("input").first()).toBeFocused();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: join(tmpdir(), `neurochess-recovery-${mode}-${info.project.name}.png`),
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("button", { name: "Enter missing keys" })).toBeFocused();
    await enterKeys(page, mode);
    await expect(resume).toHaveAttribute("aria-disabled", "false");
    await page.waitForTimeout(1_100);
    expect(turns).toBe(beforeRefresh);
    expect((await readSnapshot(page, initial.gameId)).state).toBe("paused");
    expect(
      await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
    ).toEqual({ local: 0, session: 0 });
    await resume.click();
    await cycle(page, mode, initial.gameId, 4);
    await expect(page.getByRole("button", { name: "Configure another match" })).toBeVisible();
    const finished = await readSnapshot(page, initial.gameId);
    expect(finished.terminationReason).toBe("threefold_repetition");
    expect(finished.moves.map(({ uci }) => uci)).toEqual([
      "g1f3",
      "g8f6",
      "f3g1",
      "f6g8",
      "g1f3",
      "g8f6",
      "f3g1",
      "f6g8",
    ]);
  });
}

test("closing the controlling page interrupts a provider call and reopening fences its uncertain turn", async ({
  page,
  context,
}) => {
  const initial = await start(page, "ai_vs_ai", "fixture-recovery-slow");
  await expect(
    page.getByText("White is choosing a move…", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await page.close();
  const returned = await context.newPage();
  try {
    await returned.goto("/");
    await returned.getByRole("button", { name: "Return to game" }).click();
    await expect(returned.getByText("Game paused", { exact: true })).toBeVisible();
    await expect(returned.getByRole("button", { name: "Resume", exact: true })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await returned.waitForTimeout(1_100);
    expect((await readSnapshot(returned, initial.gameId)).moves).toHaveLength(0);
    await enterKeys(returned, "ai_vs_ai");
    await returned.getByRole("button", { name: "Next move" }).click();
    await expect
      .poll(async () => (await readSnapshot(returned, initial.gameId)).moves.length)
      .toBe(1);
    expect((await readSnapshot(returned, initial.gameId)).state).toBe("paused");
  } finally {
    await returned.close();
  }
});

test("going offline during a provider call recovers paused on reconnect without an automatic retry", async ({
  page,
  context,
}) => {
  let turns = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/ai-turn")) turns++;
  });
  const initial = await start(page, "ai_vs_ai", "fixture-recovery-slow");
  await expect(
    page.getByText("White is choosing a move…", { exact: true }).filter({ visible: true }),
  ).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByRole("button", { name: "Retry recovery" })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText("Game paused", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveAttribute(
    "aria-disabled",
    "false",
  );
  await page.waitForTimeout(1_100);
  expect(turns).toBe(1);
  expect((await readSnapshot(page, initial.gameId)).moves).toHaveLength(0);
});

test("leaving between turns stops automatic requests and back navigation clears keys", async ({
  page,
}) => {
  let turns = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/ai-turn")) turns++;
  });
  const initial = await start(page, "ai_vs_ai");
  await page.getByRole("combobox", { name: "Playback speed" }).selectOption("0.5");
  await expect.poll(async () => (await readSnapshot(page, initial.gameId)).moves.length).toBe(1);
  const count = turns;
  await page.getByRole("link", { name: "Development sandbox", exact: true }).click();
  await page.waitForTimeout(2_100);
  expect(turns).toBe(count);
  await page.goBack();
  // Chromium may restore the live page from BFCache or create a fresh setup page.
  const enter = page.getByRole("button", { name: "Enter missing keys" });
  const returnGame = page.getByRole("button", { name: "Return to game" });
  await expect(enter.or(returnGame)).toBeVisible();
  if (await returnGame.isVisible()) await returnGame.click();
  await expect(page.getByText("Game paused", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect((await readSnapshot(page, initial.gameId)).moves).toHaveLength(1);
});
