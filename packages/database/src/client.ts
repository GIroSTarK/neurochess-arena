import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export interface DatabaseConnection {
  readonly db: NodePgDatabase;
  check(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase(connectionString: string): DatabaseConnection {
  const pool = new Pool({ connectionString });
  pool.on("error", () => {
    // pg removes failed idle clients; later queries can establish new connections.
    // Do not log the raw error or client, which can contain connection credentials.
    process.stderr.write("Idle database connection failed.\n");
  });
  const db = drizzle(pool);

  return {
    db,
    async check() {
      await pool.query("select 1");
    },
    async close() {
      await pool.end();
    },
  };
}
