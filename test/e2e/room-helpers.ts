import { text } from "node:stream/consumers";

import { type GameSnapshot, roomViewSchema } from "@neurochess/contracts";
import type { Page } from "@playwright/test";

import { createAccount } from "./account-helpers";
import { API_ORIGIN, WEB_ORIGIN } from "./environment";
import { expect, playMove, readSnapshot } from "./fixtures";

export async function createRoom(page: Page, color: "White" | "Black") {
  const owner = await createAccount(page.request);
  await page.goto("/rooms");
  await page.getByRole("radio", { name: color, exact: true }).check();
  await page.getByRole("button", { name: "Create room", exact: true }).click();
  await expect(page).toHaveURL(/\/games\/[a-f0-9-]+$/);
  await expect(page.getByTestId("room-connection")).toHaveText("Room connected");
  const invitation = await page
    .getByRole("textbox", { name: "Invitation link", exact: true })
    .inputValue();
  return { owner, invitation, gameId: new URL(page.url()).pathname.split("/").at(-1)! };
}

export async function joinRoom(
  page: Page,
  invitation: string,
  gameId: string,
  kind: "account" | "guest" = "guest",
) {
  await page.goto(invitation);
  await expect(page).toHaveURL(WEB_ORIGIN + "/rooms/join");
  await expect(page.getByRole("grid")).toHaveCount(0);
  await page
    .getByRole("button", { name: kind === "guest" ? "Join as guest" : "Join room", exact: true })
    .click();
  await expect(page).toHaveURL(WEB_ORIGIN + "/games/" + gameId);
  await expect(page.getByTestId("room-connection")).toHaveText("Room connected");
}

export async function confirm(page: Page, label: string, confirmLabel: string) {
  await page.getByRole("button", { name: label, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/(lifecycle|invitation|delete-account)$/.test(new URL(response.url()).pathname),
  );
  await dialog.getByRole("button", { name: confirmLabel, exact: true }).click();
  expect((await accepted).status()).toBe(200);
}

export async function room(page: Page, gameId: string) {
  const response = await page.request.get(API_ORIGIN + "/rooms/" + gameId);
  expect(response.status()).toBe(200);
  return roomViewSchema.parse(await response.json());
}

export async function playRoomLine(
  white: Page,
  black: Page,
  gameId: string,
  moves: readonly string[],
  touch = false,
) {
  let snapshot = await readSnapshot(white, gameId);
  for (const move of moves) {
    const player = snapshot.turn === "white" ? white : black;
    const opponent = player === white ? black : white;
    await expect(player.getByRole("grid")).toHaveAttribute("aria-readonly", "false");
    snapshot = await playMove(player, snapshot, move, touch);
    await expect(opponent.getByRole("status")).toContainText(snapshot.moves.at(-1)!.san);
  }
  return snapshot;
}

export async function expectSharedResult(
  players: readonly Page[],
  snapshot: GameSnapshot,
  heading: string,
) {
  for (const player of players) {
    await expect(player.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(player.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
    await expect(player.getByRole("button", { name: /^(Resign|Close room)$/ })).toHaveCount(0);
    expect(await readSnapshot(player, snapshot.gameId)).toEqual(snapshot);
    if (snapshot.moves.length > 0) {
      await player.getByRole("button", { name: "First", exact: true }).click();
    }
    await expect(
      player.getByText(`Ply 0 of ${snapshot.moves.length}`, { exact: true }),
    ).toBeVisible();
    if (snapshot.moves.length > 0) {
      await player.getByRole("button", { name: "Last", exact: true }).click();
    }
    await expect(
      player.getByText(`Ply ${snapshot.moves.length} of ${snapshot.moves.length}`, { exact: true }),
    ).toBeVisible();
    await expect(player.getByRole("grid")).toHaveAttribute("data-fen", snapshot.fen);
    const download = player.waitForEvent("download");
    await player.getByRole("button", { name: "Download PGN", exact: true }).click();
    const stream = await (await download).createReadStream();
    expect(await text(stream)).toBe(snapshot.pgn);
  }
}
