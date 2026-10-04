import { randomUUID } from "node:crypto";

import {
  gameDetailsSchema,
  type GameSnapshot,
  gameSnapshotSchema,
  moveCommandSchema,
} from "@neurochess/contracts";
import { games, guestSessions } from "@neurochess/database";
import {
  type BrowserContext,
  type BrowserContextOptions,
  type ConsoleMessage,
  expect,
  type Locator,
  type Page,
  type Response,
  test as base,
} from "@playwright/test";
import { inArray } from "drizzle-orm";

import { integrationDatabase } from "../database";

import { API_ORIGIN } from "./environment";

export { expect } from "@playwright/test";

export const test = base.extend<{
  expectedGame404s: Map<Page, Set<string>>;
  allowedIdentity401s: Map<Page, Set<string>>;
  instrumentContext: (context: BrowserContext) => Promise<void>;
  newContext: (options?: BrowserContextOptions) => Promise<BrowserContext>;
}>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructuring for fixture dependency discovery.
  expectedGame404s: async ({}, use) => {
    await use(new Map<Page, Set<string>>());
  },
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructuring for fixture dependency discovery.
  allowedIdentity401s: async ({}, use) => {
    await use(new Map<Page, Set<string>>());
  },
  instrumentContext: async ({ expectedGame404s, allowedIdentity401s }, use) => {
    const contexts = new Set<BrowserContext>();
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
    const recordError = () => errors.push("Uncaught application error");
    const recordConsole = (message: ConsoleMessage) => {
      if (["error", "warning"].includes(message.type())) {
        const page = message.page();
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
          page !== null &&
          message.text().includes("404 (Not Found)") &&
          expectedGame404s.get(page)?.delete(message.location().url);
        const expiredIdentity =
          page !== null &&
          message.text().includes("401 (Unauthorized)") &&
          allowedIdentity401s.get(page)?.has(message.location().url);
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
    };
    try {
      await use(async (context) => {
        if (contexts.has(context)) return;
        await context.addCookies([
          {
            name: "neurochess_test_client",
            value: randomUUID(),
            url: API_ORIGIN,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ]);
        contexts.add(context);
        context.on("response", record);
        context.on("weberror", recordError);
        context.on("console", recordConsole);
      });
      expect(errors).toEqual([]);
      for (const urls of expectedGame404s.values()) expect(urls.size).toBe(0);
    } finally {
      for (const context of contexts) {
        context.off("response", record);
        context.off("weberror", recordError);
        context.off("console", recordConsole);
      }
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
  context: async ({ context, instrumentContext }, use) => {
    await instrumentContext(context);
    await use(context);
  },
  newContext: async ({ browser, instrumentContext }, use) => {
    const contexts: BrowserContext[] = [];
    try {
      await use(async (options) => {
        const context = await browser.newContext(options);
        contexts.push(context);
        await instrumentContext(context);
        return context;
      });
    } finally {
      const closed = await Promise.allSettled(contexts.map((context) => context.close()));
      expect(
        closed.every((result) => result.status === "fulfilled"),
        "Extra contexts close",
      ).toBe(true);
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

export async function submitGame(page: Page) {
  const creation = page.waitForResponse(
    (response) =>
      response.url() === API_ORIGIN + "/games" && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Start game", exact: true }).click();
  const response = await creation;
  expect(response.status(), "Game creation must return HTTP 201").toBe(201);
  const body: unknown = await response.json().catch(() => undefined);
  const details = gameDetailsSchema.safeParse(body);
  if (!details.success) throw new Error("Game creation returned invalid game details");
  return { response, details: details.data };
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
