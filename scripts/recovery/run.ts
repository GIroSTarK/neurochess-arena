import { backup, parseBackupConfig } from "./backup.ts";
import { parseRestoreConfig, restore } from "./restore.ts";
import { readConfig } from "./runtime.ts";

process.umask(0o077);
try {
  const [mode, file, ...extra] = process.argv.slice(2);
  if (!file || extra.length) throw new Error();
  const config = await readConfig(file);
  if (mode === "backup") {
    await backup(parseBackupConfig(config));
    process.stdout.write('{"event":"backup","status":"success"}\n');
  } else if (mode === "restore") {
    const result = await restore(parseRestoreConfig(config));
    process.stdout.write(
      JSON.stringify({ event: "restore", status: "isolated", ...result }) + "\n",
    );
  } else throw new Error();
} catch {
  process.stderr.write('{"event":"recovery_operation","status":"failure"}\n');
  process.exitCode = 1;
}
