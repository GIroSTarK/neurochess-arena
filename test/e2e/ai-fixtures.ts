import { randomUUID } from "node:crypto";

import {
  type ChessColor,
  createAiGameRequestSchema,
  type GameSnapshot,
  gameSnapshotSchema,
  type ProviderId,
} from "@neurochess/contracts";
import type { Page } from "@playwright/test";

import { API_ORIGIN } from "./environment";
import { activate, expect, readSnapshot, square } from "./fixtures";

export const mate = ["f2f3", "e7e5", "g2g4", "d8h4"];

export function fixtureKey(scenario = "mate") {
  return `fixture-acceptance:${scenario}:${randomUUID()}`;
}

export interface AcceptanceSeat {
  readonly provider: ProviderId;
  readonly key: string;
}

export type AcceptanceMatch =
  | { readonly mode: "ai_vs_ai"; readonly white: AcceptanceSeat; readonly black: AcceptanceSeat }
  | { readonly mode: "ai_vs_human"; readonly humanColor: ChessColor; readonly ai: AcceptanceSeat };

export async function startAiMatch(page: Page, match: AcceptanceMatch, touch: boolean) {
  await page.goto("/");
  await expect(page).toHaveTitle("Set up a match · Neurochess Arena");
  if (match.mode === "ai_vs_human") {
    await page.getByRole("radio", { name: /AI vs human/ }).check();
    await page
      .getByRole("group", { name: "Your color" })
      .getByRole("radio", {
        name: match.humanColor === "white" ? "White" : "Black",
        exact: true,
      })
      .check();
  }
  for (const color of ["white", "black"] as const) {
    if (match.mode === "ai_vs_human" && color === match.humanColor) continue;
    const seat = match.mode === "ai_vs_ai" ? match[color] : match.ai;
    const panel = page.getByRole("region", {
      name: `${color === "white" ? "White" : "Black"} configuration`,
    });
    const provider = panel.getByRole("combobox", { name: "Provider" });
    await expect(provider).toHaveAttribute("aria-disabled", "false");
    await provider.selectOption(seat.provider);
    await panel.getByLabel("API key", { exact: true }).fill(seat.key);
    await activate(panel.getByRole("button", { name: "Load models" }), touch);
    const picker = panel.getByRole("combobox", { name: "Model", exact: true });
    await picker.fill("Fixture full");
    await picker.press("ArrowDown");
    await picker.press("Enter");
    await panel.getByText("Advanced parameters", { exact: true }).click();
    await panel
      .getByRole("spinbutton", { name: "Temperature" })
      .fill(color === "white" ? "0" : "1.5");
  }
  const creation = page.waitForResponse((response) => response.url() === API_ORIGIN + "/ai/games");
  await activate(page.getByRole("button", { name: "Start game" }), touch);
  const response = await creation;
  expect(response.status()).toBe(201);
  const configuration = createAiGameRequestSchema.parse(response.request().postDataJSON());
  const snapshot = gameSnapshotSchema.parse(await response.json());
  await expect(page).toHaveTitle(
    `${match.mode === "ai_vs_ai" ? "AI vs AI" : "AI vs human"} · Neurochess Arena`,
  );
  await expect(page.getByRole("grid", { name: "Chessboard" })).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  return { snapshot, configuration };
}

export async function humanMove(page: Page, move: string, touch: boolean) {
  await expect(
    page.getByText("Your turn. Choose a move on the board.", { exact: true }),
  ).toBeVisible();
  const response = page.waitForResponse(
    (response) => response.url().endsWith("/moves") && response.request().method() === "POST",
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
  expect(gameSnapshotSchema.parse(await accepted.json()).moves.at(-1)?.uci).toBe(move);
}

export async function finishMate(
  page: Page,
  match: AcceptanceMatch,
  initial: GameSnapshot,
  touch: boolean,
) {
  if (match.mode === "ai_vs_ai") {
    await page.getByRole("combobox", { name: "Playback speed" }).selectOption("2");
  } else {
    for (const [index, move] of mate.entries()) {
      if ((index % 2 === 0 ? "white" : "black") === match.humanColor) {
        await humanMove(page, move, touch);
      }
    }
  }
  await expect(page.getByRole("button", { name: "Configure another match" })).toBeVisible();
  const terminal = await readSnapshot(page, initial.gameId);
  expect(terminal).toMatchObject({
    state: "completed",
    terminationReason: "checkmate",
    result: "0-1",
  });
  expect(terminal.moves.map(({ uci }) => uci)).toEqual(mate);
  await expect(page.getByRole("grid")).toHaveAttribute("data-fen", terminal.fen);
  return terminal;
}
