import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { createCollector } from "./collector.ts";
import { ociAlarms } from "./policy.ts";
import { collectContext, parseConfig, publish, readJson, scrape } from "./runtime.ts";

async function main() {
  const mode = process.argv[2];
  const path = process.argv[3];
  if (!["collect", "configure"].includes(mode ?? "") || !path) {
    throw new Error("INVALID_MONITOR_COMMAND");
  }
  const config = parseConfig(await readJson(path));
  if (mode === "configure") {
    await mkdir(config.directory, { recursive: true, mode: 0o700 });
    for (const { query, ...alarm } of ociAlarms(config.compartmentId, config.topicId)) {
      await writeFile(
        join(config.directory, alarm.displayName + ".json"),
        JSON.stringify({ ...alarm, queryText: query }, null, 2) + "\n",
        { mode: 0o600 },
      );
    }
    process.stdout.write("Prepared eleven OCI alarm definitions; no cloud resources changed.\n");
    return;
  }
  const collector = createCollector(config, {
    scrape: () => scrape(config.containerName),
    context: () => collectContext(config),
    publish,
    event: (event) => process.stdout.write(JSON.stringify(event) + "\n"),
  });
  const abort = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort());
  while (!abort.signal.aborted) {
    const started = Date.now();
    await collector.tick(started);
    try {
      await delay(Math.max(1000, 60_000 - (Date.now() - started)), undefined, {
        signal: abort.signal,
      });
    } catch {
      break;
    }
  }
}
void main().catch(() => {
  process.stderr.write(
    "Operational collector failed; inspect local configuration and service status.\n",
  );
  process.exitCode = 1;
});
