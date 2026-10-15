import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { type Command, command, configFields, privateDirectory } from "./runtime.ts";
export interface RestoreConfig {
  container: string;
  role: string;
  directory: string;
  archiveFile: string;
  identityFile: string;
}
export function parseRestoreConfig(value: unknown): RestoreConfig {
  return configFields(
    value,
    {
      container: "identifier",
      role: "identifier",
      directory: "path",
      archiveFile: "path",
      identityFile: "path",
    },
    "INVALID_RESTORE_CONFIG",
  ) as unknown as RestoreConfig;
}
async function requireIsolation(container: string, execute: Command) {
  const inspected = JSON.parse(
    await execute("docker", ["inspect", "--type", "container", container]),
  ) as {
    Config: { Labels: Record<string, string> };
    State: { Running: unknown };
    NetworkSettings: {
      Networks: Record<string, { NetworkID: string }>;
      Ports: Record<string, { HostIp: string }[] | null>;
    };
  }[];
  const target = inspected[0];
  if (
    inspected.length !== 1 ||
    target?.State.Running !== true ||
    target.Config.Labels["io.neurochess.restore-isolated"] !== "true" ||
    Object.values(target.NetworkSettings.Ports)
      .flatMap((p) => p ?? [])
      .some((p) => !["127.0.0.1", "::1"].includes(p.HostIp))
  ) {
    throw new Error();
  }
  const networks = Object.values(target.NetworkSettings.Networks);
  if (!networks.length) throw new Error();
  for (const network of networks) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(network.NetworkID)) throw new Error();
    const result = JSON.parse(
      await execute("docker", ["network", "inspect", network.NetworkID]),
    ) as { Internal: boolean }[];
    if (result.length !== 1 || result[0]?.Internal !== true) throw new Error();
  }
}
export async function restore(
  config: RestoreConfig,
  execute: Command = command,
): Promise<{ database: string; durationMs: number }> {
  const started = performance.now();
  let work: string | undefined;
  try {
    await requireIsolation(config.container, execute);
    const size = (await stat(config.archiveFile)).size;
    if (size < 1 || size > 1_073_741_824) throw new Error();
    await privateDirectory(config.directory);
    work = await mkdtemp(join(config.directory, "restore-"));
    const plain = join(work, "database.dump");
    // Authenticate the entire age stream before PostgreSQL may execute any restored SQL.
    await execute("age", ["--decrypt", "--identity", config.identityFile, config.archiveFile], {
      outputFile: plain,
    });
    const database = `nc_restore_${randomUUID().replaceAll("-", "")}`;
    await execute("docker", [
      "exec",
      config.container,
      "createdb",
      "--username",
      "postgres",
      "--owner",
      config.role,
      "--template",
      "template0",
      database,
    ]);
    await execute(
      "docker",
      [
        "exec",
        "-i",
        config.container,
        "pg_restore",
        "--username",
        "postgres",
        "--role",
        config.role,
        "--dbname",
        database,
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "--single-transaction",
      ],
      { inputFile: plain },
    );
    return { database, durationMs: Math.ceil(performance.now() - started) };
  } catch {
    throw new Error("RESTORE_FAILED");
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
  }
}
