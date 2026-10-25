import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { type Command, command as runCommand } from "../../scripts/recovery/runtime.ts";

import { closeRecoveryEnvironment } from "./lifecycle.js";

const image =
  "postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";

export async function environment(directory: string, command: Command = runCommand) {
  const network = `nc-recovery-${randomUUID()}`;
  const containers: { name: string; container: string }[] = [];
  const secretDirectory = join(directory, "database-secrets");
  const envFile = join(directory, "restore.env");
  const overrideFile = join(directory, "restore-override.json");
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
  let networkStarted = false;
  const close = (setupFailed = false) =>
    closeRecoveryEnvironment(
      {
        containers,
        ...(composeStarted ? { compose } : {}),
        ...(networkStarted ? { network } : {}),
      },
      command,
      setupFailed,
    );
  try {
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
    await writeFile(envFile, `SECRETS_DIR=${secretDirectory.replaceAll("\\", "/")}\n`);
    await writeFile(
      overrideFile,
      JSON.stringify({ services: { postgres: { container_name: `${network}-target` } } }),
    );
    networkStarted = true;
    await command("docker", ["network", "create", "--internal", network]);
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
        containers.push({ name: "source container", container: name });
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
      containers.push({ name: `${kind} relay`, container: relay });
      await command("docker", [
        "run",
        "-d",
        "--name",
        relay,
        "--network",
        "bridge",
        "-p",
        "127.0.0.1::5432",
        "node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205",
        "node",
        "-e",
        `const net=require('node:net');net.createServer(s=>{const d=net.connect(5432,'${name}');s.on('error',()=>d.destroy());d.on('error',()=>s.destroy());s.pipe(d).pipe(s)}).listen(5432)`,
      ]);
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
    await close(true);
    throw error;
  }
}
