import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { DatabaseConnection } from "./client.js";

const defaultMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export async function runMigrations(
  connection: DatabaseConnection,
  migrationsFolder = defaultMigrationsFolder,
): Promise<void> {
  await migrate(connection.db, {
    migrationsFolder,
    migrationsSchema: "drizzle",
    migrationsTable: "__drizzle_migrations",
  });
}
