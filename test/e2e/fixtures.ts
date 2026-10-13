import { randomUUID } from "node:crypto";

import {
  gameDetailsSchema,
  type GameSnapshot,
  gameSnapshotSchema,
  moveCommandSchema,
} from "@neurochess/contracts";
import { gameParticipants, games, guestSessions } from "@neurochess/database";
import {
  type BrowserContext,
  type BrowserContextOptions,
  type ConsoleMessage,
  expect,
  type Locator,
  type Page,
  type Request,
  type Response,
  test as base,
  type Worker,
} from "@playwright/test";
import { inArray, or } from "drizzle-orm";

import { integrationDatabase } from "../database";

import { API_ORIGIN, WEB_ORIGIN } from "./environment";

export { expect } from "@playwright/test";

export const test = base.extend<{
  expectedGame404s: Map<Page, Set<string>>;
  allowedIdentity401s: Map<Page, Set<string>>;
  expectedModuleFailures: Map<Page, Set<string>>;
  expectedRouteErrors: Map<Page, Set<string>>;
  allowedNativeWarnings: Map<Page, readonly RegExp[]>;
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
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructuring for fixture dependency discovery.
  expectedModuleFailures: async ({}, use) => {
    await use(new Map<Page, Set<string>>());
  },
  // Required except in WebKit, which does not report the router diagnostic for an aborted lazy module.
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructuring for fixture dependency discovery.
  expectedRouteErrors: async ({}, use) => {
    await use(new Map<Page, Set<string>>());
  },
  // eslint-disable-next-line no-empty-pattern -- Playwright requires destructuring for fixture dependency discovery.
  allowedNativeWarnings: async ({}, use) => {
    await use(new Map<Page, readonly RegExp[]>());
  },
  instrumentContext: async (
    {
      expectedGame404s,
      allowedIdentity401s,
      expectedModuleFailures,
      expectedRouteErrors,
      allowedNativeWarnings,
      browserName,
    },
    use,
  ) => {
    const contexts = new Set<BrowserContext>();
    const createdGames = new Set<string>();
    const reads: Promise<void>[] = [];
    const errors: string[] = [];
    const navigationEpoch = new Map<Page, number>();
    const engineUrl = WEB_ORIGIN + "/engines/sf19-lite-single-v1/stockfish-19-lite-single.js";
    const engineWorkers = new Map<
      Worker,
      { page: Page; epoch: number; path: string; closed: Promise<void> }
    >();
    const cancelledEngineDiagnostics: Worker[] = [];
    const recordCrash = () => errors.push("Browser page crashed");
    const recordUncaughtError = () => errors.push("Uncaught application error");
    const watchPage = (page: Page) => {
      navigationEpoch.set(page, 0);
      page.on("crash", recordCrash);
      page.on("request", (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          navigationEpoch.set(page, (navigationEpoch.get(page) ?? 0) + 1);
        }
      });
      page.on("worker", (worker) => {
        if (worker.url() !== engineUrl) return;
        engineWorkers.set(worker, {
          page,
          epoch: navigationEpoch.get(page) ?? 0,
          path: new URL(page.url()).pathname,
          closed: new Promise((resolve) => worker.once("close", () => resolve())),
        });
      });
    };
    const networkErrors = new Map<Page, Set<string>>();
    const resourceMessages: { page: Page | null; url: string; type: string }[] = [];
    const rememberNetworkError = (page: Page, url: string) => {
      const urls = networkErrors.get(page) ?? new Set<string>();
      urls.add(url);
      networkErrors.set(page, urls);
    };
    const requestPage = (request: Request) => {
      try {
        return request.frame().page();
      } catch {
        return null;
      }
    };
    const record = (response: Response) => {
      if (response.status() >= 400) {
        const page = requestPage(response.request());
        const url = response.url();
        const status = response.status();
        if (page) rememberNetworkError(page, url);
        const expected =
          status === 409 ||
          (status === 401 &&
            ["/sandbox/games/unfinished", "/games/unfinished"].some(
              (path) => url === API_ORIGIN + path,
            )) ||
          (url.startsWith(API_ORIGIN + "/api/auth/") && [400, 401, 403, 429].includes(status)) ||
          (page !== null && status === 404 && (expectedGame404s.get(page)?.delete(url) ?? false)) ||
          (page !== null && status === 401 && (allowedIdentity401s.get(page)?.has(url) ?? false));
        if (!expected) errors.push("Unexpected HTTP response " + status);
      }
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
    const recordFailedRequest = (request: Request) => {
      const page = requestPage(request);
      if (!page) return;
      const url = request.url();
      if (
        expectedModuleFailures.get(page)?.delete(url) ||
        /^https:\/\/(?:lh3.googleusercontent.com|avatars.githubusercontent.com)\//.test(url)
      ) {
        rememberNetworkError(page, url);
      }
    };
    const recordConsole = (message: ConsoleMessage) => {
      if (["error", "warning"].includes(message.type())) {
        const worker = message.worker();
        const owner = worker ? engineWorkers.get(worker) : undefined;
        const knownCancelledLoad = [
          "WASM streaming failed: TypeError: Load failed",
          "Unhandled Promise Rejection: TypeError: Load failed",
          `Fetch API cannot load ${engineUrl.replace(/\.js$/, ".wasm")} due to access control checks.`,
        ].includes(message.text());
        // WebKit can report cancelled WASM loads from the previous document's worker.
        // Require navigation at message time and worker closure at teardown; live failures still fail.
        if (
          worker &&
          owner &&
          knownCancelledLoad &&
          (owner.page.isClosed() ||
            owner.epoch !== navigationEpoch.get(owner.page) ||
            owner.path !== new URL(owner.page.url()).pathname)
        ) {
          cancelledEngineDiagnostics.push(worker);
          return;
        }
        // Navigation may intentionally close a connecting room socket before its handshake.
        if (
          message.text() ===
          `WebSocket connection to '${API_ORIGIN.replace(/^http/, "ws")}/rooms/realtime' failed: WebSocket is closed before the connection is established.`
        ) {
          return;
        }
        // Firefox's automation bootstrap can report cancellation after a worker is terminated.
        // This chrome:// source is Playwright instrumentation, not application worker code.
        if (
          browserName === "firefox" &&
          /^\[JavaScript Error: "NS_BINDING_ABORTED: " \{file: "chrome:\/\/juggler\/content\/content\/WorkerMain\.js" line: \d+\}\]$/.test(
            message.text(),
          )
        ) {
          return;
        }
        const page = message.page();
        if (
          message.type() === "warning" &&
          page &&
          allowedNativeWarnings.get(page)?.some((pattern) => pattern.test(message.text()))
        ) {
          return;
        }
        const moduleWarning =
          /^\[JavaScript Warning: "Loading failed for the module with source “([^”]+)”/.exec(
            message.text(),
          );
        if (moduleWarning) {
          resourceMessages.push({ page, url: moduleWarning[1]!, type: message.type() });
          return;
        }
        // Engines differ in whether/when failed resources emit console messages.
        // Judge HTTP failures from responses, then reconcile only native resource diagnostics.
        if (
          /^Failed to load resource: (?:the server responded with a status of \d{3} \([^)]*\)|net::ERR_FAILED|Load failed)$/.test(
            message.text(),
          )
        ) {
          resourceMessages.push({ page, url: message.location().url, type: message.type() });
          return;
        }
        const routeError = page !== null && expectedRouteErrors.get(page)?.delete(message.text());
        if (!routeError) {
          errors.push("Application console " + message.type());
        }
      }
    };
    try {
      await use(async (context) => {
        if (contexts.has(context)) return;
        // WebKit also reports navigation-cancelled fetch diagnostics as Playwright WebErrors.
        // Listen for actual uncaught script errors/rejections without retaining their payloads.
        await context.exposeBinding("reportUncaughtTestError", recordUncaughtError);
        await context.addInitScript(() => {
          const report = () => {
            const notify = Reflect.get(window, "reportUncaughtTestError") as () => Promise<void>;
            void notify().catch(() => undefined);
          };
          window.addEventListener("error", report);
          window.addEventListener("unhandledrejection", report);
        });
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
        context.on("page", watchPage);
        context.pages().forEach(watchPage);
        context.on("response", record);
        context.on("requestfailed", recordFailedRequest);
        context.on("console", recordConsole);
        // Chromium reports unhandled worker rejections only as WebErrors: they reach neither
        // window listeners nor the console there. Firefox and WebKit log them to the console.
        if (browserName === "chromium") context.on("weberror", recordUncaughtError);
      });
      // The default page is still open here, so a terminated worker's close event can lag.
      const workerClosures = [...new Set(cancelledEngineDiagnostics)].map((worker) => {
        const owner = engineWorkers.get(worker)!;
        if (owner.page.isClosed()) return Promise.resolve(true);
        let timer: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([
          owner.closed.then(() => true),
          new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), 5_000))),
        ]).finally(() => clearTimeout(timer));
      });
      for (const closed of await Promise.all(workerClosures)) {
        if (!closed) errors.push("Engine worker with a suppressed load diagnostic stayed open");
      }
      for (const message of resourceMessages) {
        if (!message.page || !networkErrors.get(message.page)?.has(message.url)) {
          errors.push("Unexpected resource console " + message.type);
        }
      }
      expect(errors).toEqual([]);
      for (const urls of expectedGame404s.values()) expect(urls.size).toBe(0);
      for (const urls of expectedModuleFailures.values()) expect(urls.size).toBe(0);
      if (browserName !== "webkit") {
        for (const errors of expectedRouteErrors.values()) expect(errors.size).toBe(0);
      }
    } finally {
      for (const context of contexts) {
        context.off("page", watchPage);
        context.pages().forEach((page) => page.off("crash", recordCrash));
        context.off("response", record);
        context.off("requestfailed", recordFailedRequest);
        context.off("console", recordConsole);
        context.off("weberror", recordUncaughtError);
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
              await tx
                .delete(games)
                .where(
                  or(
                    inArray(games.ownerGuestSessionId, guestIds),
                    inArray(
                      games.id,
                      tx
                        .select({ id: gameParticipants.gameId })
                        .from(gameParticipants)
                        .where(inArray(gameParticipants.guestSessionId, guestIds)),
                    ),
                  ),
                );
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
