import { readFile, stat } from "node:fs/promises";

import { createDatabase, reconcileRestoredDatabase } from "@neurochess/database";

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
  const url = new URL(process.env.DATABASE_URL);
  if (
    !/^\/nc_restore_[a-f0-9]{32}$/.test(url.pathname) ||
    url.searchParams.get("sslmode") !== "verify-full"
  ) {
    throw new Error();
  }
  database = createDatabase(process.env.DATABASE_URL);
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
