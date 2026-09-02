import { createDatabase } from "@neurochess/database";

import { buildApp } from "./app.js";
import { EnvironmentValidationError, parseApiEnvironment } from "./env.js";
import { loadRootEnvironment } from "./load-root-environment.js";
import { createLoggerOptions } from "./logger.js";

async function main(): Promise<void> {
  loadRootEnvironment();
  const environment = parseApiEnvironment(process.env);
  const database = createDatabase(environment.DATABASE_URL);
  const app = await buildApp({
    logger: createLoggerOptions(environment.LOG_LEVEL),
    readiness: database,
    webOrigin: environment.WEB_ORIGIN,
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
