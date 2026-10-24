import { readFile, stat } from "node:fs/promises";

import { createDatabase, parseDatabaseUrl, reconcileRestoredDatabase } from "@neurochess/database";

import { abortSharedGame } from "../games/account-deletion.js";

let database: ReturnType<typeof createDatabase> | undefined;
try {
  const [file, ...extra] = process.argv.slice(2);
  if (
    !file ||
    extra.length ||
    !process.env.DATABASE_URL ||
    process.env.RECOVERY_ISOLATED !== "true" ||
    (await stat(file)).size > 1_048_576
  ) {
    throw new Error();
  }
  const databaseUrl = parseDatabaseUrl(process.env.DATABASE_URL, true);
  const url = new URL(databaseUrl);
  if (!/^\/nc_restore_[a-f0-9]{32}$/.test(url.pathname)) {
    throw new Error();
  }
  database = createDatabase(databaseUrl);
  await reconcileRestoredDatabase(
    database,
    JSON.parse(await readFile(file, "utf8")) as unknown,
    abortSharedGame,
  );
  process.stdout.write('{"event":"restore_reconciliation","status":"success"}\n');
} catch {
  process.stderr.write('{"event":"restore_reconciliation","status":"failure"}\n');
  process.exitCode = 1;
} finally {
  await database?.close();
}
