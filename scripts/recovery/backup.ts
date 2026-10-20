import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { atomicJson, type Command, command, configFields, privateDirectory } from "./runtime.ts";

export interface BackupConfig {
  container: string;
  database: string;
  role: string;
  directory: string;
  recipientFile: string;
  namespace: string;
  bucket: string;
}
export function parseBackupConfig(value: unknown): BackupConfig {
  return configFields(
    value,
    {
      container: "identifier",
      database: "identifier",
      role: "identifier",
      directory: "path",
      recipientFile: "path",
      namespace: "identifier",
      bucket: "identifier",
    },
    "INVALID_BACKUP_CONFIG",
  ) as unknown as BackupConfig;
}
export async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
async function requireDestination(cloud: string[], bytes: number, execute: Command) {
  const bucket = JSON.parse(await execute("oci", ["os", "bucket", "get", ...cloud])) as {
    data: { "public-access-type": string; versioning: string };
  };
  if (
    bucket.data["public-access-type"] !== "NoPublicAccess" ||
    bucket.data.versioning !== "Disabled"
  ) {
    throw new Error();
  }
  const policy = JSON.parse(
    await execute("oci", ["os", "object-lifecycle-policy", "get", ...cloud]),
  ) as {
    data: {
      items: {
        action: string;
        "is-enabled": unknown;
        target: string;
        "time-amount": number;
        "time-unit": string;
        "object-name-filter": {
          "inclusion-prefixes": string[];
          "inclusion-patterns"?: string[] | null;
          "exclusion-patterns"?: string[] | null;
        };
      }[];
    };
  };
  const rule = policy.data.items[0];
  if (
    policy.data.items.length !== 1 ||
    rule?.action !== "DELETE" ||
    rule["is-enabled"] !== true ||
    rule.target !== "objects" ||
    rule["time-amount"] !== 7 ||
    rule["time-unit"] !== "DAYS" ||
    JSON.stringify(rule["object-name-filter"]["inclusion-prefixes"]) !== '["database/"]' ||
    (rule["object-name-filter"]["inclusion-patterns"]?.length ?? 0) !== 0 ||
    (rule["object-name-filter"]["exclusion-patterns"]?.length ?? 0) !== 0
  ) {
    throw new Error();
  }
  // A bounded listing fails closed if the dedicated bucket grows beyond inspectable capacity.
  const objects = JSON.parse(
    await execute("oci", ["os", "object", "list", ...cloud, "--all", "--fields", "name,size"]),
  ) as {
    data?: { size: number }[];
    prefixes?: unknown;
  };
  // OCI CLI omits data for an empty bucket and emits only { "prefixes": [] }.
  const entries =
    objects.data === undefined &&
    Object.keys(objects).length === 1 &&
    Array.isArray(objects.prefixes) &&
    objects.prefixes.length === 0
      ? []
      : objects.data;
  if (!Array.isArray(entries)) throw new Error();
  let total = bytes;
  for (const object of entries) {
    if (!Number.isSafeInteger(object.size) || object.size < 0) throw new Error();
    total += object.size;
    if (!Number.isSafeInteger(total) || total > 8_589_934_592) throw new Error();
  }
}
export async function backup(config: BackupConfig, execute: Command = command): Promise<void> {
  await privateDirectory(config.directory);
  const work = join(config.directory, "running");
  // An interrupted job leaves its lock for operator inspection; never steal a live lock.
  try {
    await mkdir(work, { mode: 0o700 });
  } catch {
    throw new Error("BACKUP_LOCKED");
  }
  const startedAt = new Date().toISOString();
  const plain = join(work, "database.dump");
  const encrypted = join(work, "database.dump.age");
  const readback = join(work, "readback.age");
  const name = `database/${startedAt.replaceAll(":", "-")}-${randomUUID()}.dump.age`;
  const cloud = [
    "--namespace-name",
    config.namespace,
    "--bucket-name",
    config.bucket,
    "--auth",
    "instance_principal",
    "--region",
    "eu-frankfurt-1",
    "--no-retry",
    "--connection-timeout",
    "10",
    "--read-timeout",
    "120",
  ];
  try {
    await execute(
      "docker",
      [
        "exec",
        config.container,
        "pg_dump",
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--lock-wait-timeout=30000",
        "--username",
        config.role,
        "--dbname",
        config.database,
      ],
      { outputFile: plain },
    );
    await execute("age", ["--encrypt", "--recipients-file", config.recipientFile, plain], {
      outputFile: encrypted,
    });
    await rm(plain);
    await requireDestination(cloud, (await stat(encrypted)).size, execute);
    await execute("oci", [
      "os",
      "object",
      "put",
      ...cloud,
      "--name",
      name,
      "--file",
      encrypted,
      "--no-overwrite",
      "--no-multipart",
      "--verify-checksum",
    ]);
    await execute(
      "oci",
      ["os", "object", "get", ...cloud, "--name", name, "--file", "-", "--no-multipart"],
      { outputFile: readback },
    );
    if ((await digest(encrypted)) !== (await digest(readback))) throw new Error();
    await rm(work, { recursive: true, force: true });
    await atomicJson(config.directory, "status.json", {
      status: "success",
      startedAt,
      completedAt: new Date().toISOString(),
    });
  } catch {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    await atomicJson(config.directory, "status.json", {
      status: "failure",
      startedAt,
      completedAt: new Date().toISOString(),
    });

    throw new Error("BACKUP_FAILED");
  }
}
