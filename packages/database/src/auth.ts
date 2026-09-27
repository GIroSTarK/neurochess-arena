import { AsyncLocalStorage } from "node:async_hooks";

import { drizzleAdapter } from "@better-auth/drizzle-adapter";

import type { DatabaseConnection } from "./client.js";
import * as schema from "./schema/auth.js";

type Database = DatabaseConnection["db"];
export type AuthTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const authTransactions = new AsyncLocalStorage<AuthTransaction>();

export function createAuthAdapter(database: DatabaseConnection) {
  const { db } = database;
  // Better Auth's Drizzle adapter opens PostgreSQL transactions only through db.transaction and
  // exposes no handle to them. Track the active one so identity admission can run inside the same
  // transaction as the identity write.
  const tracked = Object.create(db, {
    transaction: {
      value: (...[work, config]: Parameters<Database["transaction"]>) =>
        db.transaction((tx) => authTransactions.run(tx, () => work(tx)), config),
    },
  }) as Database;
  return drizzleAdapter(tracked, { provider: "pg", schema, transaction: true });
}

export function currentAuthTransaction(): AuthTransaction | undefined {
  return authTransactions.getStore();
}
