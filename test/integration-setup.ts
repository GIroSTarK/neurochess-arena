import { runMigrations } from "@neurochess/database";

import { integrationDatabase } from "./database.js";

export default async function setup(): Promise<void> {
  const database = integrationDatabase();
  try {
    await database.check();
    await runMigrations(database);
    await runMigrations(database);
  } catch {
    throw new Error(
      "Integration database setup failed. Start the test PostgreSQL service and check TEST_DATABASE_URL; migrations must apply successfully.",
    );
  } finally {
    await database.close();
  }
}
