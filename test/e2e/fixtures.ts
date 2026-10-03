import { randomUUID } from "node:crypto";

import {
  gameDetailsSchema,
  type GameSnapshot,
  gameSnapshotSchema,
  moveCommandSchema,
} from "@neurochess/contracts";
import { games, guestSessions } from "@neurochess/database";
import { expect, type Locator, type Page, type Response, test as base } from "@playwright/test";
import { inArray } from "drizzle-orm";

import { integrationDatabase } from "../database";

import { API_ORIGIN } from "./environment";

export { expect } from "@playwright/test";

export const test = base.extend<{
  expectedGameDetails404s: Set<string>;
  allowedIdentity401s: Set<string>;
}>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructuring for fixture dependency discovery.
  expectedGameDetails404s: async ({}, use) => {
    await use(new Set<string>());
  },
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructuring for fixture dependency discovery.
  allowedIdentity401s: async ({}, use) => {
    await use(new Set<string>());
  },
  page: async ({ page, expectedGameDetails404s, allowedIdentity401s }, use) => {
    await page.context().addCookies([
      {
        name: "neurochess_test_client",
        value: randomUUID(),
        url: API_ORIGIN,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    const createdGames = new Set<string>();
    const reads: Promise<void>[] = [];
    const errors: string[] = [];
    const record = (response: Response) => {
      if (response.url() === API_ORIGIN + "/sandbox/games" && response.status() === 201) {
        reads.push(
          response.json().then((value: unknown) => {
            const snapshot = gameSnapshotSchema.safeParse(value);
            if (snapshot.success) createdGames.add(snapshot.data.gameId);
          }),
        );
      }
      if (response.url() === API_ORIGIN + "/games" && response.status() === 201) {
        reads.push(
          response.json().then((value: unknown) => {
            const game = gameDetailsSchema.safeParse(value);
            if (game.success) createdGames.add(game.data.snapshot.gameId);
          }),
        );
      }
    };
    page.on("response", record);
    page.on("pageerror", () => errors.push("Uncaught application error"));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        // HTTP error statuses are expected during creation conflicts. Never
        // copy arbitrary console text or request/cookie headers into reports.
        const anonymousDiscovery =
          ["/sandbox/games/unfinished", "/games/unfinished"].some(
            (path) => message.location().url === API_ORIGIN + path,
          ) && message.text().includes("401 (Unauthorized)");
        const accountRejection =
          message.location().url.startsWith(API_ORIGIN + "/api/auth/") &&
          /(?:400|401|403|429) \(/.test(message.text());
        const avatarUnavailable =
          /https:\/\/(?:lh3.googleusercontent.com|avatars.githubusercontent.com)\//.test(
            message.location().url,
          ) && message.text().includes("net::ERR_FAILED");
        const deletedPrivateGame =
          message.text().includes("404 (Not Found)") &&
          expectedGameDetails404s.delete(message.location().url);
        const expiredIdentity =
          message.text().includes("401 (Unauthorized)") &&
          allowedIdentity401s.has(message.location().url);
        if (
          !message.text().includes("409 (Conflict)") &&
          !anonymousDiscovery &&
          !accountRejection &&
          !avatarUnavailable &&
          !deletedPrivateGame &&
          !expiredIdentity
        ) {
          errors.push("Application console " + message.type());
        }
      }
    });
    try {
      await use(page);
      expect(errors).toEqual([]);
      expect(expectedGameDetails404s.size).toBe(0);
    } finally {
      page.off("response", record);
      await Promise.allSettled(reads);
      if (createdGames.size > 0) {
        const database = integrationDatabase();
        try {
          const owners = await database.db
            .select({ id: games.ownerGuestSessionId })
            .from(games)
            .where(inArray(games.id, [...createdGames]));
          const guestIds = [
            ...new Set(owners.map((owner) => owner.id).filter((id) => id !== null)),
          ];
          if (guestIds.length > 0) {
            await database.db.transaction(async (tx) => {
              await tx.delete(games).where(inArray(games.ownerGuestSessionId, guestIds));
              await tx.delete(guestSessions).where(inArray(guestSessions.id, guestIds));
            });
          }
        } finally {
          await database.close();
        }
      }
    }
  },
});

export async function activate(locator: Locator, touch: boolean) {
  if (touch) await locator.tap();
  else await locator.click();
}

export function square(page: Page, coordinate: string): Locator {
  return page.locator('[data-square="' + coordinate + '"]');
}

export async function startSandbox(page: Page, touch: boolean): Promise<GameSnapshot> {
  await page.goto("/sandbox");
  await expect(page).toHaveTitle("Development sandbox · Neurochess Arena");
  await expect(page.getByRole("heading", { name: "Sandbox" })).toBeVisible();
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
  const start = page.getByRole("button", { name: "Start sandbox", exact: true });
  await expect(start).toBeEnabled();
  const response = page.waitForResponse(
    (response) =>
      response.url() === API_ORIGIN + "/sandbox/games" && response.request().method() === "POST",
  );
  await activate(start, touch);
  const creation = await response;
  expect(creation.status()).toBe(201);
  const snapshot = gameSnapshotSchema.parse(await creation.json());
  await expect(page.getByRole("grid", { name: "Chessboard" })).toBeVisible();
  expect(snapshot.moves).toEqual([]);
  expect(snapshot.state).toBe("active");
  return snapshot;
}

export async function acceptedMove(
  response: Response,
  previous: GameSnapshot,
  move: string,
  page: Page,
) {
  expect(response.status()).toBe(200);
  const command = moveCommandSchema.parse(response.request().postDataJSON());
  expect(command).toMatchObject({
    expectedVersion: previous.version,
    gameId: previous.gameId,
    move,
  });
  const accepted = gameSnapshotSchema.parse(await response.json());
  expect(accepted.gameId).toBe(previous.gameId);
  expect(accepted.version).toBeGreaterThan(previous.version);
  expect(accepted.moves.at(-1)?.uci).toBe(move);
  await expect(page.getByRole("status")).toContainText(accepted.moves.at(-1)?.san ?? "");
  return accepted;
}

export async function playMove(
  page: Page,
  previous: GameSnapshot,
  move: string,
  touch: boolean,
): Promise<GameSnapshot> {
  expect(previous.legalMoves).toContain(move);
  await activate(square(page, move.slice(0, 2)), touch);
  const response = page.waitForResponse(
    (response) =>
      response.url() === API_ORIGIN + "/games/" + previous.gameId + "/moves" &&
      response.request().method() === "POST",
  );
  await activate(square(page, move.slice(2, 4)), touch);
  if (move.length === 5) {
    const names: Record<string, string> = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" };
    const piece = names[move[4] ?? ""];
    if (!piece) throw new Error("Unknown promotion piece in " + move);
    await activate(
      page.getByRole("dialog").getByRole("button", { name: "Promote to " + piece }),
      touch,
    );
  }
  return acceptedMove(await response, previous, move, page);
}

export async function readSnapshot(page: Page, gameId: string): Promise<GameSnapshot> {
  const response = await page.request.get(API_ORIGIN + "/games/" + gameId);
  expect(response.status()).toBe(200);
  return gameSnapshotSchema.parse(await response.json());
}
