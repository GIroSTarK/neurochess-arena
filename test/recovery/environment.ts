import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { command } from "../../scripts/recovery/runtime.ts";

const image =
  "postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";

export async function environment(directory: string) {
  const network = `nc-recovery-${randomUUID()}`;
  const containers: string[] = [];
  const secretDirectory = join(directory, "database-secrets");
  await mkdir(secretDirectory, { mode: 0o700 });
  const password = randomBytes(24).toString("hex");
  await writeFile(
    join(secretDirectory, "postgres-admin-password"),
    randomBytes(24).toString("hex"),
    { mode: 0o600 },
  );
  await writeFile(join(secretDirectory, "postgres-app-password"), password, { mode: 0o600 });
  const certificate = join(secretDirectory, "postgres-cert.pem");
  const opensslConfig = join(directory, "openssl.cnf");
  await writeFile(opensslConfig, "[req]\ndistinguished_name=dn\n[dn]\n");
  await command("openssl", [
    "req",
    "-config",
    opensslConfig,
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=postgres",
    "-addext",
    "subjectAltName=DNS:postgres,IP:127.0.0.1",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    join(secretDirectory, "postgres-key.pem"),
    "-out",
    certificate,
  ]);
  const envFile = join(directory, "restore.env");
  const overrideFile = join(directory, "restore-override.json");
  await writeFile(envFile, `SECRETS_DIR=${secretDirectory.replaceAll("\\", "/")}\n`);
  await writeFile(
    overrideFile,
    JSON.stringify({ services: { postgres: { container_name: `${network}-target` } } }),
  );
  const compose = [
    "compose",
    "--project-name",
    `${network}-target`,
    "--env-file",
    envFile,
    "-f",
    resolve("deploy/recovery/compose.yml"),
    "-f",
    overrideFile,
  ];
  let composeStarted = false;
  await command("docker", ["network", "create", "--internal", network]);
  async function close() {
    const removed = await Promise.allSettled(
      containers.map((container) => command("docker", ["rm", "-f", "--volumes", container])),
    );
    if (composeStarted) {
      await command("docker", [...compose, "down", "--volumes", "--remove-orphans"]);
    }
    await command("docker", ["network", "rm", network]);
    if (removed.some((result) => result.status === "rejected")) {
      throw new Error("RECOVERY_DRILL_CLEANUP_FAILED");
    }
  }
  try {
    const databases = [];
    for (const kind of ["source", "target"]) {
      const name = `${network}-${kind}`;
      let databaseNetwork = network;
      if (kind === "target") {
        composeStarted = true;
        await command("docker", [...compose, "config", "--quiet"]);
        await command("docker", [...compose, "up", "-d", "--wait"]);
        databaseNetwork = `${network}-target_database`;
      } else {
        await command("docker", [
          "run",
          "-d",
          "--name",
          name,
          "--network",
          network,
          "--label",
          "io.neurochess.restore-isolated=true",
          "--tmpfs",
          "/var/lib/postgresql",
          "-e",
          "POSTGRES_HOST_AUTH_METHOD=trust",
          "-e",
          "POSTGRES_DB=neurochess",
          image,
        ]);
        containers.push(name);
        let ready = false;
        for (let attempt = 0; attempt < 80; attempt++) {
          try {
            await command("docker", [
              "exec",
              name,
              "pg_isready",
              "-h",
              "127.0.0.1",
              "-U",
              "postgres",
              "-d",
              "neurochess",
            ]);
            ready = true;
            break;
          } catch {
            await delay(250);
          }
        }
        if (!ready) throw new Error("RECOVERY_DRILL_DATABASE_UNAVAILABLE");
        await command("docker", [
          "exec",
          name,
          "psql",
          "-U",
          "postgres",
          "-d",
          "neurochess",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          "CREATE ROLE neurochess LOGIN; ALTER DATABASE neurochess OWNER TO neurochess; REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT ALL ON SCHEMA public TO neurochess;",
        ]);
      }
      // Internal Docker networks disable published ports. A fixture-only loopback relay
      // lets the host test process connect without giving PostgreSQL an outbound route.
      const relay = `${name}-relay`;
      await command("docker", [
        "run",
        "-d",
        "--name",
        relay,
        "--network",
        "bridge",
        "-p",
        "127.0.0.1::5432",
        "node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df",
        "node",
        "-e",
        `const net=require('node:net');net.createServer(s=>{const d=net.connect(5432,'${name}');s.on('error',()=>d.destroy());d.on('error',()=>s.destroy());s.pipe(d).pipe(s)}).listen(5432)`,
      ]);
      containers.push(relay);
      await command("docker", ["network", "connect", databaseNetwork, relay]);
      const port = (await command("docker", ["port", relay, "5432/tcp"])).trim();
      if (!/^127\.0\.0\.1:\d+$/.test(port)) throw new Error("RECOVERY_DRILL_UNSAFE_PORT");
      databases.push({
        name,
        url: (database: string) =>
          kind === "source"
            ? `postgresql://neurochess@${port}/${database}`
            : `postgresql://neurochess:${password}@${port}/${database}?sslmode=verify-full&sslrootcert=${encodeURIComponent(certificate)}`,
      });
    }
    return {
      source: databases[0]!,
      target: databases[1]!,
      close,
      recovery: {
        compose,
        network: `${network}-target_database`,
        volume: `${network}-target_restored-data`,
        secretDirectory,
        certificate,
        password,
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
