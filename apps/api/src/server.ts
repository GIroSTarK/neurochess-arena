import {
  createCredentialRepository,
  createDatabase,
  createGameRepository,
  createProfileRepository,
} from "@neurochess/database";

import { buildApp } from "./app.js";
import { createAccountAuth } from "./auth/service.js";
import { createAuthEmailSender } from "./auth/smtp.js";
import { createCredentialCipher } from "./credentials/crypto.js";
import { createCredentialService } from "./credentials/service.js";
import { EnvironmentValidationError, parseApiEnvironment } from "./env.js";
import { createGameService } from "./games/service.js";
import { createGuestService } from "./guests/service.js";
import { loadRootEnvironment } from "./load-root-environment.js";
import { createLoggerOptions } from "./logger.js";
import { createProfileService } from "./profiles/service.js";
import { createAnthropicAdapter } from "./providers/anthropic.js";
import { createGoogleAdapter } from "./providers/google.js";
import { createOpenAiAdapter } from "./providers/openai.js";
import { createOpenRouterAdapter } from "./providers/openrouter.js";
import { createRoomEvents } from "./realtime/room-events.js";
import { createRoomService } from "./rooms/service.js";

async function main(): Promise<void> {
  loadRootEnvironment();
  const environment = parseApiEnvironment(process.env);
  const database = createDatabase(environment.DATABASE_URL);
  const repository = createGameRepository(database);
  const roomEvents = createRoomEvents();
  const credentialCipher =
    environment.CREDENTIAL_ENCRYPTION_KEY_ID && environment.CREDENTIAL_ENCRYPTION_KEY
      ? createCredentialCipher({
          keyId: environment.CREDENTIAL_ENCRYPTION_KEY_ID,
          key: environment.CREDENTIAL_ENCRYPTION_KEY,
        })
      : undefined;
  const app = await buildApp({
    logger: createLoggerOptions(environment.LOG_LEVEL),
    readiness: database,
    webOrigin: environment.WEB_ORIGIN,
    auth: createAccountAuth(database, environment, createAuthEmailSender(environment), roomEvents),
    profiles: createProfileService(createProfileRepository(database)),
    credentials: createCredentialService(createCredentialRepository(database), credentialCipher),
    rooms: createRoomService(repository, roomEvents),
    roomEvents,
    gameApi: {
      games: createGameService(repository, {
        roomEvents,
        nodeEnv: environment.NODE_ENV,
        sandboxEnabled: environment.SANDBOX_ENABLED,
        ...(credentialCipher ? { credentialCipher } : {}),
        aiAdapters: {
          openai: createOpenAiAdapter(),
          anthropic: createAnthropicAdapter(),
          google: createGoogleAdapter(),
          openrouter: createOpenRouterAdapter(),
        },
      }),
      guests: createGuestService(repository, environment.GUEST_SESSION_TTL_SECONDS),
    },
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => {
    shutdownPromise ??= (async () => {
      app.log.info({ signal }, "Shutting down API");
      await app.close();
      await database.close();
    })();
    return shutdownPromise;
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal).catch(() => {
        process.exitCode = 1;
      });
    });
  }

  try {
    await app.listen({ host: environment.API_HOST, port: environment.API_PORT });
  } catch (error: unknown) {
    app.log.fatal({ err: error }, "API failed to start");
    await shutdown("startup_failure");
    throw error;
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof EnvironmentValidationError ? error.message : "The API could not be started.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
