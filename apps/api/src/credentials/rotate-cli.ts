import { readFile, stat } from "node:fs/promises";

import { createDatabase, parseDatabaseUrl } from "@neurochess/database";

import { maintainCredentials } from "./rotation.js";

const failure = '{"event":"credential_maintenance","status":"failure"}\n';
// Checked-out database clients can emit errors outside the transaction promise.
// Termination closes the connection; an uncertain commit is resolved by verification.
process.on("uncaughtException", () => {
  process.stderr.write(failure);
  process.exit(1);
});

let database: ReturnType<typeof createDatabase> | undefined;
let count: number | undefined;
try {
  const [mode, file, ...extra] = process.argv.slice(2);
  if (!file || extra.length) throw new Error();
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size > 8192 || (metadata.mode & 0o077) !== 0) {
    throw new Error();
  }
  const manifest: unknown = JSON.parse(await readFile(file, "utf8"));
  database = createDatabase(parseDatabaseUrl(process.env.DATABASE_URL, true));
  count = await maintainCredentials(database, manifest, mode);
} catch {
  process.exitCode = 1;
} finally {
  try {
    await database?.close();
  } catch {
    process.exitCode = 1;
  }
}
if (process.exitCode === 1) {
  process.stderr.write(failure);
} else {
  process.stdout.write(
    JSON.stringify({ event: "credential_maintenance", status: "success", rows: count }) + "\n",
  );
}
