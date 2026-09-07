import { tmpdir } from "node:os";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import {
  type ChessColor,
  type GameSnapshot,
  gameSnapshotSchema,
  moveCommandSchema,
} from "@neurochess/contracts";
import type { Page } from "@playwright/test";

import { API_ORIGIN } from "./environment";
import { activate, expect, readSnapshot, square, test } from "./fixtures";

const mate = ["f2f3", "e7e5", "g2g4", "d8h4"];
const promotionApproach = ["a2a4", "h7h5", "a4a5", "h5h4", "a5a6", "h4h3", "a6b7", "h3g2"];

async function start(page: Page, humanColor: ChessColor, key = "fixture-playback") {
  await page.goto("/");
  await page.getByRole("radio", { name: /AI vs human/ }).check();
  await page
    .getByRole("group", { name: "Your color" })
    .getByRole("radio", { name: humanColor === "white" ? "White" : "Black", exact: true })
    .check();
  const panel = page.getByRole("region", {
    name: `${humanColor === "white" ? "Black" : "White"} configuration`,
  });
  const provider = panel.getByRole("combobox", { name: "Provider" });
  await expect(provider).toHaveAttribute("aria-disabled", "false");
  await provider.selectOption("openai");
  await panel.getByLabel("API key", { exact: true }).fill(key);
  await panel.getByRole("button", { name: "Load models" }).click();
  const model = panel.getByRole("combobox", { name: "Model", exact: true });
  await model.fill("Fixture full");
  await model.press("ArrowDown");
  await model.press("Enter");
  const response = page.waitForResponse((response) => response.url() === API_ORIGIN + "/ai/games");
  await page.getByRole("button", { name: "Start game" }).click();
  const created = await response;
  expect(created.status()).toBe(201);
  const initial = gameSnapshotSchema.parse(await created.json());
  await expect(page).toHaveTitle("AI vs human · Neurochess Arena");
  await expect(page.getByRole("heading", { name: "AI vs human", exact: true })).toBeVisible();
  await expect(page.getByRole("grid", { name: "Chessboard" })).toBeVisible();
  await expect(page.locator("[data-square]").first()).toHaveAttribute(
    "data-square",
    humanColor === "white" ? "a8" : "h1",
  );
  await expect(page.locator(`[data-seat="${humanColor}"]`)).toContainText("Guest");
  await expect(
    page.locator(`[data-seat="${humanColor === "white" ? "black" : "white"}"]`),
  ).toContainText("fixture-full");
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Next move" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Playback speed" })).toHaveCount(0);
  return initial;
}

async function waitForHuman(page: Page) {
  await expect(
    page
      .getByRole("group", { name: "AI versus human controls" })
      .getByText("Your turn. Choose a move on the board.", { exact: true }),
  ).toBeVisible();
}

async function humanMove(page: Page, before: GameSnapshot, move: string, touch: boolean) {
  await waitForHuman(page);
  const response = page.waitForResponse(
    (response) => response.url() === `${API_ORIGIN}/games/${before.gameId}/moves`,
  );
  for (const coordinate of [move.slice(0, 2), move.slice(2, 4)]) {
    if (touch) await square(page, coordinate).tap();
    else {
      await square(page, coordinate).focus();
      await square(page, coordinate).press("Enter");
    }
  }
  const accepted = await response;
  expect(accepted.status()).toBe(200);
  expect(moveCommandSchema.parse(accepted.request().postDataJSON())).toMatchObject({
    move,
    expectedVersion: before.version,
  });
  return gameSnapshotSchema.parse(await accepted.json());
}

async function aiMove(page: Page, before: GameSnapshot) {
  await expect
    .poll(async () => (await readSnapshot(page, before.gameId)).moves.length)
    .toBe(before.moves.length + 1);
  return readSnapshot(page, before.gameId);
}

for (const humanColor of ["white", "black"] as const) {
  test(`human ${humanColor} completes checkmate through keyboard or touch with automatic AI replies`, async ({
    page,
  }, info) => {
    let humanRequests = 0;
    let aiRequests = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/moves")) humanRequests++;
      if (request.url().endsWith("/ai-turn")) aiRequests++;
    });
    let current = await start(page, humanColor);
    for (const move of mate) {
      if (current.turn === humanColor) {
        current = await humanMove(page, current, move, info.project.name === "mobile-touch");
      } else {
        const before = humanRequests;
        await activate(square(page, move.slice(0, 2)), info.project.name === "mobile-touch");
        await activate(square(page, move.slice(2, 4)), info.project.name === "mobile-touch");
        expect(humanRequests).toBe(before);
        current = await aiMove(page, current);
      }
    }
    await expect(page.getByRole("button", { name: "Configure another match" })).toBeVisible();
    expect(current).toMatchObject({
      state: "completed",
      terminationReason: "checkmate",
      result: "0-1",
    });
    expect(current.moves.map(({ uci }) => uci)).toEqual(mate);
    expect(await readSnapshot(page, current.gameId)).toEqual(current);
    await page.waitForTimeout(1_100);
    expect(humanRequests).toBe(2);
    expect(aiRequests).toBe(2);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
  });

  test(`human ${humanColor} chooses an underpromotion explicitly from the standard position`, async ({
    page,
  }, info) => {
    const touch = info.project.name === "mobile-touch";
    let current = await start(page, humanColor, "fixture-human-promotion");
    const approach = humanColor === "white" ? promotionApproach : [...promotionApproach, "b7a8n"];
    for (const move of approach) {
      current =
        current.turn === humanColor
          ? await humanMove(page, current, move, touch)
          : await aiMove(page, current);
    }
    await waitForHuman(page);
    const move = humanColor === "white" ? "b7a8n" : "g2h1r";
    await activate(square(page, move.slice(0, 2)), touch);
    await activate(square(page, move.slice(2, 4)), touch);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: /^Promote to / })).toHaveCount(4);
    await expect(dialog.getByRole("button", { name: "Promote to Queen" })).toBeFocused();
    expect(await readSnapshot(page, current.gameId)).toEqual(current);
    await activate(dialog.getByRole("button", { name: "Cancel" }), touch);
    await expect(dialog).toHaveCount(0);
    await expect(square(page, move.slice(2, 4))).toBeFocused();
    await activate(square(page, move.slice(2, 4)), touch);
    const response = page.waitForResponse((response) =>
      response.url().endsWith(`/games/${current.gameId}/moves`),
    );
    await activate(
      dialog.getByRole("button", {
        name: humanColor === "white" ? "Promote to Knight" : "Promote to Rook",
      }),
      touch,
    );
    const accepted = await response;
    expect(accepted.status()).toBe(200);
    expect(moveCommandSchema.parse(accepted.request().postDataJSON()).move).toBe(move);
    await waitForHuman(page);
    await expect(square(page, move.slice(2, 4))).toHaveAttribute(
      "aria-label",
      humanColor === "white" ? /White knight/ : /Black rook/,
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
    await page.screenshot({
      path: join(tmpdir(), `neurochess-human-${humanColor}-${info.project.name}.png`),
      fullPage: true,
    });
  });

  test(`human ${humanColor} can cancel and confirm their own resignation while AI is thinking`, async ({
    page,
  }, info) => {
    let current = await start(page, humanColor, "fixture-held-human-opponent");
    if (humanColor === "white") {
      current = await humanMove(page, current, "f2f3", info.project.name === "mobile-touch");
    }
    const controls = page.getByRole("group", { name: "AI versus human controls" });
    await expect(controls).toContainText(
      `${humanColor === "white" ? "Black" : "White"} is choosing a move`,
    );
    const name = humanColor === "white" ? "Resign White" : "Resign Black";
    await expect(
      page.getByRole("button", { name: humanColor === "white" ? "Resign Black" : "Resign White" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name }).click();
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await readSnapshot(page, current.gameId)).toEqual(current);
    await page.getByRole("button", { name }).click();
    await page.getByRole("button", { name: "Confirm resignation" }).click();
    await expect(page.getByRole("button", { name: "Configure another match" })).toBeVisible();
    const resigned = await readSnapshot(page, current.gameId);
    expect(resigned).toMatchObject({
      state: "completed",
      terminationReason: "human_resignation",
      result: humanColor === "white" ? "0-1" : "1-0",
      moves: current.moves,
      version: current.version + 1,
    });
  });
}
