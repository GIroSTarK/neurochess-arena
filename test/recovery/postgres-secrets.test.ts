import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { expect, it } from "vitest";

import { command } from "../../scripts/recovery/runtime.ts";

it("initializes PostgreSQL with private secrets owned by a different host user", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nc-postgres-secrets-"));
  const container = `nc-postgres-secrets-${randomUUID()}`;
  let created = false;
  try {
    for (const name of ["postgres-admin-password", "postgres-app-password"]) {
      await writeFile(join(directory, name), randomBytes(32).toString("hex"), { mode: 0o600 });
    }
    await writeFile(join(directory, "openssl.cnf"), "[req]\ndistinguished_name=dn\n[dn]\n");
    await command("openssl", [
      "req",
      "-config",
      join(directory, "openssl.cnf"),
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=postgres",
      "-keyout",
      join(directory, "postgres-key"),
      "-out",
      join(directory, "postgres-cert"),
    ]);
    await command("docker", [
      "create",
      "--name",
      container,
      "--network",
      "none",
      "--tmpfs",
      "/run/secrets",
      "--tmpfs",
      "/var/lib/postgresql",
      "-v",
      `${directory}:/fixture:ro`,
      "-v",
      `${resolve("deploy")}:/opt/neurochess:ro`,
      "-v",
      `${resolve("deploy/postgres-init.sh")}:/docker-entrypoint-initdb.d/10-neurochess.sh:ro`,
      "-v",
      `${resolve("deploy/recovery/pg_hba.conf")}:/etc/postgresql/pg_hba.conf:ro`,
      "-e",
      "POSTGRES_DB=neurochess",
      "-e",
      "POSTGRES_PASSWORD_FILE=/run/secrets/postgres-admin-password",
      "-e",
      "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256",
      "--entrypoint",
      "sh",
      "postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873",
      "-ec",
      // Create Linux permissions inside the container, including on Windows Docker hosts.
      "for name in postgres-admin-password postgres-app-password postgres-key postgres-cert; do install -m 600 -o 1001 -g 1001 /fixture/$name /run/secrets/$name; done; exec sh /opt/neurochess/postgres-entrypoint.sh",
    ]);
    created = true;
    await command("docker", ["start", container]);
    await expect
      .poll(
        () =>
          command("docker", [
            "exec",
            container,
            "sh",
            "-ec",
            'PGPASSWORD="$(cat /run/secrets/postgres-app-password)" PGSSLMODE=require psql -h 127.0.0.1 -U neurochess -d neurochess -Atc "SELECT current_user"',
          ])
            .then((output) => output.trim())
            .catch(() => "unavailable"),
        { timeout: 20_000, interval: 250 },
      )
      .toBe("neurochess");
    expect(
      (
        await command("docker", [
          "exec",
          container,
          "stat",
          "-c",
          "%a %u:%g",
          "/run/secrets/postgres-app-password",
        ])
      ).trim(),
    ).toBe("600 1001:1001");
  } finally {
    try {
      if (created) await command("docker", ["rm", "-f", "--volumes", container]);
    } finally {
      expect(dirname(directory)).toBe(tmpdir());
      await rm(directory, { recursive: true, force: true });
    }
  }
});
