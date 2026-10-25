import { randomUUID } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join, resolve } from "node:path";

import { type Command, command } from "../../scripts/recovery/runtime.ts";

import type { environment } from "./environment.js";
import { closePromotion } from "./lifecycle.js";

type Infrastructure = Awaited<ReturnType<typeof environment>>;
export async function recoveryApiEnvironment(
  directory: string,
  infra: Infrastructure,
  database: string,
  secrets: { auth: string; keyId: string; key: string },
) {
  const file = join(directory, "recovered-api.env");
  await writeFile(
    file,
    [
      `DATABASE_URL=postgresql://neurochess:${infra.recovery.password}@postgres:5432/${database}?sslmode=verify-full&sslrootcert=/run/secrets/postgres-cert`,
      `BETTER_AUTH_SECRET=${secrets.auth}`,
      `CREDENTIAL_ENCRYPTION_KEY_ID=${secrets.keyId}`,
      `CREDENTIAL_ENCRYPTION_KEY=${secrets.key}`,
      "AUTH_EMAIL_TRANSPORT=smtp",
      "AUTH_EMAIL_FROM=accounts@example.com",
      "SMTP_HOST=smtp.invalid",
      "SMTP_PORT=587",
      "SMTP_SECURITY=starttls",
      "SMTP_USER=synthetic",
      "SMTP_PASSWORD=synthetic",
      "LOG_LEVEL=silent",
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  return file;
}
export async function runReconciliation(
  infra: Infrastructure,
  apiEnv: string,
  manifestFile: string,
) {
  const { uid, gid } = await stat(manifestFile);
  return command("docker", [
    "run",
    "--rm",
    "--user",
    `${uid}:${gid}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--network",
    infra.recovery.network,
    "--env-file",
    apiEnv,
    "-e",
    "RECOVERY_ISOLATED=true",
    "-v",
    `${infra.recovery.certificate}:/run/secrets/postgres-cert:ro`,
    "-v",
    `${manifestFile}:/recovery-manifest.json:ro`,
    process.env.DEPLOY_API_IMAGE ?? "neurochess-api:p5-10",
    "node",
    "apps/api/dist/operations/reconcile-cli.js",
    "/recovery-manifest.json",
  ]);
}
export async function promote(
  directory: string,
  infra: Infrastructure,
  apiEnv: string,
  runCommand: Command = command,
) {
  const project = `nc-promote-${randomUUID()}`;
  const envFile = join(directory, "promoted.env");
  const overrideFile = join(directory, "promoted-isolation.json");
  let composeStarted = false;
  const relay = `${project}-relay`;
  let relayCreated = false;
  const compose = [
    "compose",
    "--project-name",
    project,
    "--env-file",
    envFile,
    "-f",
    resolve("deploy/compose.yml"),
    "-f",
    resolve("deploy/recovery/promote.override.yml"),
    "-f",
    overrideFile,
  ];
  const close = (setupFailed = false) =>
    closePromotion(
      {
        ...(relayCreated ? { relay } : {}),
        ...(composeStarted ? { compose } : {}),
      },
      runCommand,
      setupFailed,
    );
  try {
    await writeFile(
      envFile,
      [
        `API_IMAGE=${process.env.DEPLOY_API_IMAGE ?? "neurochess-api:p5-10"}`,
        "WEB_IMAGE=neurochess-web:p5-10",
        "WEB_ORIGIN=https://arena.example.com",
        "BETTER_AUTH_URL=https://api.example.com",
        `API_ENV_FILE=${apiEnv.replaceAll("\\", "/")}`,
        `SECRETS_DIR=${infra.recovery.secretDirectory.replaceAll("\\", "/")}`,
        `RECOVERED_VOLUME=${infra.recovery.volume}`,
        "EDGE_SUBNET=172.31.254.0/24",
        "EDGE_DYNAMIC_RANGE=172.31.254.128/25",
        "PROXY_IP=172.31.254.2",
      ].join("\n") + "\n",
    );
    await writeFile(
      overrideFile,
      JSON.stringify({
        services: { api: { container_name: `${project}-api` } },
        networks: { edge: { internal: true } },
      }),
    );
    await runCommand("docker", [...infra.recovery.compose, "stop", "postgres"]);
    const state = await runCommand("docker", [
      "inspect",
      "--format",
      "{{.State.Running}}",
      infra.target.name,
    ]);
    if (state.trim() !== "false") throw new Error("RECOVERY_OWNER_STILL_RUNNING");
    composeStarted = true;
    await runCommand("docker", [...compose, "config", "--quiet"]);
    await runCommand("docker", [...compose, "up", "-d", "--wait", "postgres"]);
    await runCommand("docker", [...compose, "run", "--rm", "migrate"]);
    await runCommand("docker", [...compose, "up", "-d", "--wait", "api"]);
    relayCreated = true;
    await runCommand("docker", [
      "run",
      "-d",
      "--name",
      relay,
      "--network",
      "bridge",
      "-p",
      "127.0.0.1::3001",
      "node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205",
      "node",
      "-e",
      `const net=require('node:net');net.createServer(s=>{const d=net.connect(3001,'${project}-api');s.on('error',()=>d.destroy());d.on('error',()=>s.destroy());s.pipe(d).pipe(s)}).listen(3001)`,
    ]);
    await runCommand("docker", ["network", "connect", `${project}_edge`, relay]);
    const address = (await runCommand("docker", ["port", relay, "3001/tcp"])).trim();
    if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error("UNSAFE_PROMOTION_RELAY");
    return {
      container: `${project}-postgres-1`,
      close,
      read: (path: string, cookie: string, body?: unknown) =>
        new Promise<{ status: number; body: unknown; cookie: string }>(
          (resolveResponse, reject) => {
            const encoded = body === undefined ? undefined : JSON.stringify(body);
            const req = request(
              `http://${address}${path}`,
              {
                method: encoded ? "POST" : "GET",
                headers: {
                  cookie,
                  ...(encoded
                    ? {
                        origin: "https://arena.example.com",
                        "content-type": "application/json",
                        "content-length": Buffer.byteLength(encoded),
                      }
                    : {}),
                },
              },
              (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (data: Buffer) => chunks.push(data));
                response.on("error", reject);
                response.on("end", () =>
                  resolveResponse({
                    status: response.statusCode ?? 0,
                    body: JSON.parse(Buffer.concat(chunks).toString()) as unknown,
                    cookie: (response.headers["set-cookie"] ?? [])
                      .map((value) => value.split(";")[0])
                      .join("; "),
                  }),
                );
              },
            );
            req.on("error", reject);
            req.setTimeout(10_000, () => req.destroy(new Error("PROMOTION_REQUEST_TIMEOUT")));
            req.end(encoded);
          },
        ),
    };
  } catch (error) {
    await close(true);
    throw error;
  }
}
