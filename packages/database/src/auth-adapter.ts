import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq } from "drizzle-orm";

import type { DatabaseConnection } from "./client.js";
import * as schema from "./schema/auth.js";

export function createAuthDatabaseAdapter(database: DatabaseConnection) {
  return drizzleAdapter(database.db, { provider: "pg", schema, transaction: true });
}

export async function withAuthUserLock<T>(
  database: DatabaseConnection,
  userId: string,
  operation: (adapter: ReturnType<typeof createAuthDatabaseAdapter>) => Promise<T>,
): Promise<T> {
  return database.db.transaction(async (transaction) => {
    const [user] = await transaction
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.id, userId))
      .for("update");
    if (!user) throw new Error("Authentication account is unavailable");
    // Password verification/session creation and reset/revocation must share
    // both this account lock and connection, including nested adapter work.
    return operation(drizzleAdapter(transaction, { provider: "pg", schema, transaction: true }));
  });
}
