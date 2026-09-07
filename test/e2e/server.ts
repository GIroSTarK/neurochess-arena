import { fileURLToPath } from "node:url";

import {
  createGameRepository,
  type GameRepository,
  games,
  guestSessions,
  runMigrations,
} from "@neurochess/database";
import { inArray } from "drizzle-orm";
import { createServer } from "vite";

import { buildApp } from "../../apps/api/src/app.js";
import { createGameService } from "../../apps/api/src/games/service.js";
import { createGuestService } from "../../apps/api/src/guests/service.js";
import { integrationDatabase } from "../database.js";

import { API_ORIGIN, WEB_ORIGIN } from "./environment.js";
import { setupProviders } from "./providers.js";

async function main() {
  // This guard runs before creating a pool, applying migrations or listening.
  // There is deliberately no DATABASE_URL fallback and no reuse of a dev API.
  const database = integrationDatabase();
  const guestIds = new Set<string>();
  const original = createGameRepository(database);
  const repository: GameRepository = {
    ...original,
    async createGuest(hash, ttl) {
      const guest = await original.createGuest(hash, ttl);
      guestIds.add(guest.id);
      return guest;
    },
  };
  const app = await buildApp({
    readiness: database,
    webOrigin: WEB_ORIGIN,
    gameApi: {
      guests: createGuestService(repository, 86_400),
      games: createGameService(repository, {
        nodeEnv: "test",
        sandboxEnabled: true,
        ai: { providers: setupProviders },
      }),
    },
  });
  process.env.VITE_API_BASE_URL = API_ORIGIN;
  const web = await createServer({
    root: fileURLToPath(new URL("../../apps/web", import.meta.url)),
    configFile: fileURLToPath(new URL("../../apps/web/vite.config.ts", import.meta.url)),
    mode: "test",
    server: { host: "localhost", port: Number(new URL(WEB_ORIGIN).port), strictPort: true },
    logLevel: "error",
  });
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= (async () => {
      await web.close();
      await app.close();
      try {
        if (guestIds.size > 0) {
          await database.db.transaction(async (tx) => {
            await tx.delete(games).where(inArray(games.ownerGuestSessionId, [...guestIds]));
            await tx.delete(guestSessions).where(inArray(guestSessions.id, [...guestIds]));
          });
        }
      } finally {
        await database.close();
      }
    })();
    return closing;
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void close().catch(() => {
        process.exitCode = 1;
      });
    });
  }
  try {
    await database.check();
    await runMigrations(database);
    await app.listen({ host: "localhost", port: Number(new URL(API_ORIGIN).port) });
    await web.listen();
    process.stdout.write("Sandbox browser test services ready.\n");
  } catch {
    await close();
    throw new Error(
      "Browser test services could not start; check the disposable test database and test ports.",
    );
  }
}

void main().catch(() => {
  process.stderr.write(
    "Browser test setup failed. TEST_DATABASE_URL must target the disposable test service; ports 3101 and 5174 must be free.\n",
  );
  process.exitCode = 1;
});
