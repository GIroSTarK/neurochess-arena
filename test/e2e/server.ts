import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCredentialRepository,
  createGameRepository,
  createProfileRepository,
  gameParticipants,
  type GameRepository,
  games,
  guestSessions,
  runMigrations,
} from "@neurochess/database";
import { inArray, or } from "drizzle-orm";
import { createServer } from "vite";

import { createAnalysisService } from "../../apps/api/src/analysis/service.js";
import { buildApp } from "../../apps/api/src/app.js";
import { createCredentialCipher } from "../../apps/api/src/credentials/crypto.js";
import { createCredentialService } from "../../apps/api/src/credentials/service.js";
import { createGameService } from "../../apps/api/src/games/service.js";
import { createGuestService } from "../../apps/api/src/guests/service.js";
import { createProfileService } from "../../apps/api/src/profiles/service.js";
import { createRoomEvents } from "../../apps/api/src/realtime/room-events.js";
import { createRoomService } from "../../apps/api/src/rooms/service.js";
import { integrationDatabase } from "../database.js";

import { accountHarness } from "./account-harness.js";
import { API_ORIGIN, DISABLED_WEB_ORIGIN, WEB_ORIGIN } from "./environment.js";
import { closeResources, notifyParent, shutdownMessage } from "./lifecycle.js";
import { setupHarness } from "./setup-harness.js";
import { setupProviders } from "./setup-providers.js";

async function main() {
  // This guard runs before creating a pool, applying migrations or listening.
  // There is deliberately no DATABASE_URL fallback and no reuse of a dev API.
  const database = integrationDatabase();
  const roomEvents = createRoomEvents();
  const accounts = accountHarness(database, roomEvents);
  const credentialCipher = createCredentialCipher({
    keyId: "browser-fixture",
    key: randomBytes(32).toString("base64"),
  });
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
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let web: Awaited<ReturnType<typeof createServer>> | undefined;
  let disabledWeb: Awaited<ReturnType<typeof createServer>> | undefined;
  let closing: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;

  function close(): Promise<void> {
    closing ??= closeResources([
      { name: "web", close: () => web?.close() },
      { name: "disabled web", close: () => disabledWeb?.close() },
      { name: "API", close: () => app?.close() },
      { name: "test accounts", close: () => accounts.close() },
      {
        name: "test guests",
        close: async () => {
          if (guestIds.size > 0) {
            await database.db.transaction(async (tx) => {
              await tx.delete(games).where(
                or(
                  inArray(games.ownerGuestSessionId, [...guestIds]),
                  inArray(
                    games.id,
                    tx
                      .select({ id: gameParticipants.gameId })
                      .from(gameParticipants)
                      .where(inArray(gameParticipants.guestSessionId, [...guestIds])),
                  ),
                ),
              );
              await tx.delete(guestSessions).where(inArray(guestSessions.id, [...guestIds]));
            });
          }
        },
      },
      { name: "database pool", close: () => database.close() },
    ]);
    return closing;
  }

  function stop(): Promise<void> {
    stopping ??= (async () => {
      // Let startup settle so it cannot add resources after cleanup has passed them.
      await startup.catch(() => undefined);
      try {
        await close();
      } catch {
        process.stderr.write("Browser test cleanup failed.\n");
        process.exitCode = 1;
      }
      try {
        await notifyParent(process.exitCode ? "failed" : "stopped");
      } catch {
        process.exitCode = 1;
      } finally {
        if (process.connected) process.disconnect();
      }
    })();
    return stopping;
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void stop());
  }
  process.on("message", (message: unknown) => {
    if (!shutdownMessage.safeParse(message).success) process.exitCode = 1;
    void stop();
  });
  process.once("disconnect", () => void stop());
  const startup = start();
  try {
    await startup;
    if (!stopping) {
      process.stdout.write("Sandbox browser test services ready.\n");
      await notifyParent("ready");
    }
  } catch {
    process.stderr.write(
      "Browser test services could not start; check the disposable test database and test ports.\n",
    );
    process.exitCode = 1;
    await stop();
  }

  async function start() {
    app = await buildApp({
      analysis: createAnalysisService(repository),
      roomRealtimeLimits: { heartbeatMs: 250, pongTimeoutMs: 1000, reconciliationMs: 250 },
      readiness: database,
      webOrigin: WEB_ORIGIN,
      auth: accounts.auth,
      profiles: createProfileService(createProfileRepository(database)),
      credentials: createCredentialService(createCredentialRepository(database), credentialCipher),
      rooms: createRoomService(repository, roomEvents),
      roomEvents,
      gameApi: {
        guests: createGuestService(repository, 86_400),
        games: createGameService(repository, {
          roomEvents,
          nodeEnv: "test",
          sandboxEnabled: true,
          aiAdapters: setupProviders(),
          credentialCipher,
        }),
      },
    });
    accounts.install(app);
    process.env.VITE_API_BASE_URL = API_ORIGIN;
    process.env.SANDBOX_ENABLED = "false";
    disabledWeb = await createServer({
      cacheDir: join(tmpdir(), "neurochess-playwright-disabled-vite"),
      root: fileURLToPath(new URL("../../apps/web", import.meta.url)),
      configFile: fileURLToPath(new URL("../../apps/web/vite.config.ts", import.meta.url)),
      mode: "test",
      server: {
        host: "localhost",
        port: Number(new URL(DISABLED_WEB_ORIGIN).port),
        strictPort: true,
      },
      logLevel: "error",
    });
    process.env.SANDBOX_ENABLED = "true";
    web = await createServer({
      plugins: [setupHarness()],
      root: fileURLToPath(new URL("../../apps/web", import.meta.url)),
      configFile: fileURLToPath(new URL("../../apps/web/vite.config.ts", import.meta.url)),
      mode: "test",
      server: { host: "localhost", port: Number(new URL(WEB_ORIGIN).port), strictPort: true },
      logLevel: "error",
    });
    await database.check();
    await runMigrations(database);
    await app.listen({ host: "localhost", port: Number(new URL(API_ORIGIN).port) });
    await disabledWeb.listen();
    await web.listen();
  }
}

void main().catch(() => {
  process.stderr.write(
    "Browser test setup failed. TEST_DATABASE_URL must target the disposable test service; ports 3101, 5174 and 5175 must be free.\n",
  );
  process.exitCode = 1;
});
