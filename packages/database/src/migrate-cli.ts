import { createDatabase } from "./client.js";
import { parseDatabaseUrl } from "./database-url.js";
import { loadRootEnvironment } from "./local-env.js";
import { runMigrations } from "./migrations.js";

try {
  loadRootEnvironment();
  if (process.env.NODE_ENV === "production" && process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error();
  }
  const connection = createDatabase(
    parseDatabaseUrl(process.env.DATABASE_URL, process.env.NODE_ENV === "production"),
  );
  try {
    await runMigrations(connection);
    process.stdout.write("Database migrations are current.\n");
  } finally {
    await connection.close();
  }
} catch {
  process.stderr.write(
    "Database migration failed. Check configuration and database availability.\n",
  );
  process.exitCode = 1;
}
