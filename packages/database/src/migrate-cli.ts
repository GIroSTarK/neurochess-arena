import { createDatabase } from "./client.js";
import { parseDatabaseUrl } from "./database-url.js";
import { loadRootEnvironment } from "./local-env.js";
import { runMigrations } from "./migrations.js";

loadRootEnvironment();

const connection = createDatabase(parseDatabaseUrl(process.env.DATABASE_URL));

try {
  await runMigrations(connection);
  process.stdout.write("Database migrations are current.\n");
} finally {
  await connection.close();
}
