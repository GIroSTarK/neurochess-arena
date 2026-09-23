import { drizzleAdapter } from "@better-auth/drizzle-adapter";

import type { DatabaseConnection } from "./client.js";
import * as schema from "./schema/auth.js";

export function createAuthAdapter(database: DatabaseConnection) {
  return drizzleAdapter(database.db, { provider: "pg", schema, transaction: true });
}
