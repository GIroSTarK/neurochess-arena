import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";

import { describe, expect, it } from "vitest";

import { deriveSignals } from "../../../scripts/monitoring/policy.ts";
import { backup, parseBackupConfig } from "../../../scripts/recovery/backup.ts";
import { restore } from "../../../scripts/recovery/restore.ts";
import { type Command, command } from "../../../scripts/recovery/runtime.ts";

describe("bounded recovery commands", () => {
  it("refuses a filesystem root in configuration before any filesystem operation", () => {
    expect(() =>
      parseBackupConfig({
        container: "db",
        database: "neurochess",
        role: "neurochess",
        directory: parse(tmpdir()).root,
        recipientFile: join(tmpdir(), "public-recipient"),
        namespace: "fixture",
        bucket: "fixture",
      }),
    ).toThrow("INVALID_BACKUP_CONFIG");
  });
  it("streams binary output without publishing it and rejects excessive output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nc-recovery-unit-"));
    try {
      const outputFile = join(directory, "binary");
      await command(process.execPath, ["-e", "process.stdout.write(Buffer.from([0,255,10]))"], {
        outputFile,
      });
      expect(await readFile(outputFile)).toEqual(Buffer.from([0, 255, 10]));
      await expect(
        command(process.execPath, ["-e", "process.stdout.write('x'.repeat(32769))"]),
      ).rejects.toThrow("RECOVERY_COMMAND_FAILED");
    } finally {
      expect(dirname(directory)).toBe(tmpdir());
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("bounds execution and discards raw child errors and arguments", async () => {
    await expect(
      command(process.execPath, ["-e", "process.stderr.write('secret-canary');process.exit(1)"]),
    ).rejects.toThrow(/^RECOVERY_COMMAND_FAILED$/);
    await expect(
      command(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 50 }),
    ).rejects.toThrow(/^RECOVERY_COMMAND_FAILED$/);
  });
});

describe("isolated restoration admission", () => {
  it.each([
    "unlabelled",
    "public-network",
    "public-port",
    "string-state",
    "decrypt",
    "restore",
    "success",
  ])(
    "handles %s without overwriting existing databases or feeding unauthenticated plaintext to PostgreSQL",
    async (condition) => {
      const directory = await mkdtemp(join(tmpdir(), "nc-restore-unit-"));
      const effects: string[] = [];
      try {
        const archiveFile = join(directory, "backup.age");
        await writeFile(archiveFile, "fixture");
        const execute: Command = async (program, args, options) => {
          if (args[0] === "inspect") {
            return JSON.stringify([
              {
                Config: {
                  Labels: {
                    "io.neurochess.restore-isolated": condition === "unlabelled" ? "false" : "true",
                  },
                },
                State: { Running: condition === "string-state" ? "true" : true },
                NetworkSettings: {
                  Networks: { private: { NetworkID: "network-id" } },
                  Ports: {
                    "5432/tcp": [
                      {
                        HostIp: condition === "public-port" ? "0.0.0.0" : "127.0.0.1",
                        HostPort: "15432",
                      },
                    ],
                  },
                },
              },
            ]);
          }
          if (args[0] === "network") {
            return JSON.stringify([{ Internal: condition !== "public-network" }]);
          }
          if (program === "age") {
            await writeFile(options!.outputFile!, "partial-plaintext");
            if (condition === "decrypt") throw new Error("private-decrypt-canary");
          }
          if (args.includes("createdb")) effects.push("created");
          if (args.includes("pg_restore")) {
            effects.push("restore");
            expect(args).toContain("--single-transaction");
            expect(args).not.toContain("--clean");
            if (condition === "restore") throw new Error("private-sql-canary");
          }
          return "";
        };
        const config = {
          container: "restore",
          role: "neurochess",
          directory,
          archiveFile,
          identityFile: join(directory, "identity"),
        };
        if (condition === "success") {
          const result = await restore(config, execute);
          expect(result.database).toMatch(/^nc_restore_[a-f0-9]{32}$/);
          expect(effects).toEqual(["created", "restore"]);
        } else {
          await expect(restore(config, execute)).rejects.toThrow(/^RESTORE_FAILED$/);
          expect(effects).toEqual(condition === "restore" ? ["created", "restore"] : []);
        }
        expect(await readdir(directory)).toEqual(["backup.age"]);
      } finally {
        expect(dirname(directory)).toBe(tmpdir());
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("backup publication", () => {
  it("measures data age from the snapshot start instead of a delayed upload completion", () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    const signals = deriveSignals(null, null, {
      now,
      backupMaxAgeSeconds: 86400,
      backup: {
        status: "success",
        completedAt: "2026-10-15T12:00:00Z",
        startedAt: "2026-10-14T11:59:59Z",
      },
    });
    expect(signals.backupFailure).toBe(1);
  });
  it.each([
    "string-retention",
    "success",
    "dump",
    "encrypt",
    "put",
    "get",
    "corrupt",
    "public",
    "versioned",
    "retention",
    "quota",
  ])(
    "records %s evidence only after encrypted off-host readback and removes work files",
    async (failure) => {
      const directory = await mkdtemp(join(tmpdir(), "nc-backup-unit-"));
      let remote = Buffer.alloc(0);
      try {
        const config = parseBackupConfig({
          container: "postgres-fixture",
          database: "neurochess",
          role: "neurochess",
          directory,
          recipientFile: join(directory, "recipient"),
          namespace: "fixture",
          bucket: "private-backups",
        });
        const execute: Command = async (program, args, options) => {
          if (args[1] === "bucket") {
            return JSON.stringify({
              data: {
                "public-access-type": failure === "public" ? "ObjectRead" : "NoPublicAccess",
                versioning: failure === "versioned" ? "Enabled" : "Disabled",
              },
            });
          }
          if (args[1] === "object-lifecycle-policy") {
            return JSON.stringify({
              data: {
                items: [
                  {
                    action: "DELETE",
                    "is-enabled": failure === "string-retention" ? "true" : true,
                    target: "objects",
                    "time-amount": failure === "retention" ? 30 : 7,
                    "time-unit": "DAYS",
                    "object-name-filter": {
                      "inclusion-prefixes": ["database/"],
                      "exclusion-patterns": [],
                      "inclusion-patterns": [],
                    },
                  },
                ],
              },
            });
          }
          if (args[2] === "list") {
            return JSON.stringify({
              data: [
                { name: "database/old.dump.age", size: failure === "quota" ? 8_589_934_592 : 100 },
              ],
            });
          }
          const phase = program === "docker" ? "dump" : program === "age" ? "encrypt" : args[2];
          if (phase === failure) throw new Error("private-command-error");
          if (phase === "dump") await writeFile(options!.outputFile!, "private-dump-canary");
          if (phase === "encrypt") await writeFile(options!.outputFile!, "encrypted-fixture");
          if (phase === "put") remote = await readFile(args[args.indexOf("--file") + 1]!);
          if (phase === "get") {
            await writeFile(
              options?.outputFile ?? args[args.indexOf("--file") + 1]!,
              failure === "corrupt" ? "wrong" : remote,
            );
          }
          return "{}";
        };
        if (failure === "success") await backup(config, execute);
        else await expect(backup(config, execute)).rejects.toThrow(/^BACKUP_FAILED$/);
        const status = await readFile(join(directory, "status.json"), "utf8");
        expect(JSON.parse(status)).toEqual({
          status: failure === "success" ? "success" : "failure",
          startedAt: expect.any(String) as unknown,
          completedAt: expect.any(String) as unknown,
        });
        expect(status).not.toContain("canary");
        expect(await readdir(directory)).toEqual(["status.json"]);
        if (failure === "success") expect(remote.toString()).toBe("encrypted-fixture");
        if (["public", "versioned", "retention", "quota"].includes(failure)) {
          expect(remote.length).toBe(0);
        }
      } finally {
        expect(dirname(directory)).toBe(tmpdir());
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it("rejects malformed paths, command-like identifiers and unexpected secret fields", () => {
    for (const value of [
      null,
      {},
      { container: "-x" },
      { directory: "relative" },
      { apiKey: "private" },
    ]) {
      expect(() => parseBackupConfig(value)).toThrow(/^INVALID_BACKUP_CONFIG$/);
    }
  });
});
