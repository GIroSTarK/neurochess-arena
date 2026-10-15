import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { chromium, firefox, webkit } from "@playwright/test";
import WebSocket from "ws";

const directory = await mkdtemp(join(tmpdir(), "neurochess-deployment-"));
const project = "nc-rehearsal-" + randomBytes(4).toString("hex");
const web = "https://localhost:8443";
const api = "https://localhost:8444";
const apiImage = process.env.DEPLOY_API_IMAGE ?? "neurochess-api:p5-10";
const webImage = process.env.DEPLOY_WEB_IMAGE ?? "neurochess-web:p5-10";
let ca;
let configured = false;
const sockets = [];
const browsers = [];
const redactions = [];
const composeArgs = [
  "compose",
  "--project-name",
  project,
  "--env-file",
  join(directory, "deploy.env"),
  "-f",
  resolve("deploy/compose.yml"),
  "-f",
  join(directory, "override.json"),
];

async function command(program, args, input) {
  const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let output = "";
  let diagnostic = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  // Keep subprocess diagnostics in memory: never publish raw credential-bearing output.
  child.stderr.on("data", (chunk) => {
    diagnostic += chunk;
  });
  child.stdin.end(input);
  const [code] = await once(child, "exit");
  if (code !== 0) {
    for (const secret of redactions) diagnostic = diagnostic.replaceAll(secret, "[redacted]");
    diagnostic = diagnostic.replaceAll(/postgres(?:ql)?:\/\/\S+/g, "[database URL]");
    throw new Error(`${program} failed (${code}): ${diagnostic.slice(-2000)}`);
  }
  return output;
}
const compose = (...args) => command("docker", [...composeArgs, ...args]);
const step = (text) => process.stdout.write(text + "\n");

function request(url, { method = "GET", cookie, data, headers = {} } = {}) {
  return new Promise((resolveResponse, reject) => {
    const body = data === undefined ? undefined : JSON.stringify(data);
    const request = httpsRequest(
      url,
      {
        ca,
        method,
        headers: {
          origin: web,
          ...(cookie ? { cookie } : {}),
          ...(body
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
            : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolveResponse({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
            json: () => JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    request.on("error", reject);
    request.setTimeout(15_000, () => request.destroy(new Error("Rehearsal request timed out")));
    request.end(body);
  });
}
async function until(check, label) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if (await check()) return;
    } catch {
      /* Services may still be starting. */
    }
    await delay(250);
  }
  throw new Error(label);
}
async function post(path, data, cookie) {
  const result = await request(api + path, { method: "POST", data, cookie });
  assert.equal(result.status, 200, `POST ${path}`);
  return result;
}
const cookieFrom = (response) =>
  response.headers["set-cookie"].map((value) => value.split(";")[0]).join("; ");

try {
  for (const origin of ["http://localhost:3001", "https://fixture:build-canary@invalid.example"]) {
    await assert.rejects(
      command("docker", [
        "build",
        "-f",
        "deploy/Dockerfile",
        "--target",
        "web",
        "--build-arg",
        `VITE_API_BASE_URL=${origin}`,
        ".",
      ]),
      /INVALID_WEB_ENVIRONMENT|INVALID_PRODUCTION_API_ORIGIN/,
    );
  }
  await command("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "node",
    apiImage,
    "--input-type=module",
    "-e",
    `
    import { existsSync } from 'node:fs';
    for (const path of ['/app/.env', '/app/apps/api/test', '/app/test']) {
      if (existsSync(path)) throw new Error('Unexpected production runtime artifact');
    }
  `,
  ]);
  const password = randomBytes(32).toString("hex");
  await writeFile(join(directory, "postgres-admin-password"), randomBytes(32).toString("hex"));
  await writeFile(join(directory, "postgres-app-password"), password);
  await writeFile(join(directory, "openssl.cnf"), "[req]\ndistinguished_name=dn\n[dn]\n");
  await command("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-config",
    join(directory, "openssl.cnf"),
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-subj",
    "/CN=postgres",
    "-addext",
    "subjectAltName=DNS:postgres,DNS:mail,DNS:localhost",
    "-keyout",
    join(directory, "postgres-key.pem"),
    "-out",
    join(directory, "postgres-cert.pem"),
  ]);
  ca = await readFile(join(directory, "postgres-cert.pem"));
  await writeFile(
    join(directory, "api.env"),
    [
      `DATABASE_URL=postgresql://neurochess:${password}@postgres:5432/neurochess?sslmode=verify-full&sslrootcert=/run/secrets/postgres-cert`,
      `BETTER_AUTH_SECRET=${randomBytes(32).toString("base64")}`,
      "CREDENTIAL_ENCRYPTION_KEY_ID=rehearsal",
      `CREDENTIAL_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
      "AUTH_EMAIL_TRANSPORT=smtp",
      "AUTH_EMAIL_FROM=arena@example.com",
      "SMTP_HOST=mail",
      "SMTP_PORT=1025",
      "SMTP_SECURITY=tls",
      "NODE_EXTRA_CA_CERTS=/run/secrets/postgres-cert",
      "LOG_LEVEL=warn",
    ].join("\n"),
  );
  redactions.push(
    password,
    ...(await readFile(join(directory, "api.env"), "utf8"))
      .split("\n")
      .map((line) => line.slice(line.indexOf("=") + 1))
      .filter((value) => value.length > 20),
  );
  await writeFile(
    join(directory, "deploy.env"),
    [
      `API_IMAGE=${apiImage}`,
      `WEB_IMAGE=${webImage}`,
      `WEB_ORIGIN=${web}`,
      `BETTER_AUTH_URL=${api}`,
      `API_ENV_FILE=${join(directory, "api.env").replaceAll("\\", "/")}`,
      `SECRETS_DIR=${directory.replaceAll("\\", "/")}`,
      "EDGE_SUBNET=172.31.242.0/24",
      "EDGE_DYNAMIC_RANGE=172.31.242.128/25",
      "PROXY_IP=172.31.242.2",
    ].join("\n"),
  );
  const caddy = (await readFile("deploy/Caddyfile", "utf8")).replaceAll(
    "} {",
    "} {\n\ttls /fixture/postgres-cert.pem /fixture/postgres-key.pem",
  );
  await writeFile(join(directory, "Caddyfile"), caddy);
  // Reset production port publishing; every rehearsal listener is loopback-only.
  await writeFile(
    join(directory, "override.json"),
    JSON.stringify({
      services: {
        web: {
          ports: ["127.0.0.1:8443:8443", "127.0.0.1:8444:8444"],
          volumes: [
            `${join(directory, "Caddyfile")}:/etc/caddy/Caddyfile:ro`,
            `${directory}:/fixture:ro`,
          ],
        },
        mail: {
          image: apiImage,
          user: "0:0",
          entrypoint: ["node", "/smtp.mjs"],
          networks: ["edge"],
          volumes: [
            `${directory}:/fixture:ro`,
            `${resolve("test/deployment/smtp.mjs")}:/smtp.mjs:ro`,
          ],
          ports: ["127.0.0.1:1026:1026"],
        },
      },
    }),
  );
  // Compose's explicit reset tag is YAML-only, so use a tiny additional override.
  await writeFile(
    join(directory, "ports.yml"),
    "services:\n  web:\n    ports: !override\n      - '127.0.0.1:8443:8443'\n      - '127.0.0.1:8444:8444'\n",
  );
  composeArgs.push("-f", join(directory, "ports.yml"));
  await compose("config", "--quiet");
  configured = true;
  step("Starting isolated PostgreSQL with verified TLS; applying migrations twice.");
  await compose("up", "-d", "--wait", "postgres", "mail");
  const canary = "private-token-" + randomUUID();
  await command(
    "docker",
    [...composeArgs, "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "neurochess"],
    `CREATE TEMP TABLE privacy_probe (token text PRIMARY KEY);\nINSERT INTO privacy_probe VALUES ('${canary}');\nINSERT INTO privacy_probe VALUES ('${canary}');\n`,
  );
  const databaseLogs = await compose("logs", "--no-color", "postgres");
  assert.equal(
    databaseLogs.includes(canary),
    false,
    "PostgreSQL errors must not log private row values",
  );
  await compose("run", "--rm", "migrate");
  await compose("run", "--rm", "migrate");
  await compose("up", "-d", "--wait", "api", "web");
  await until(async () => (await request(api + "/ready")).status === 200, "API never became ready");
  for (const mode of ["plaintext", "untrusted-certificate"]) {
    await compose(
      "exec",
      "-T",
      "-e",
      "NODE_EXTRA_CA_CERTS=",
      "api",
      "node",
      "--input-type=module",
      "-e",
      `
      import { createDatabase } from '@neurochess/database';
      const url = new URL(process.env.DATABASE_URL);
      if ('${mode}' === 'plaintext') url.searchParams.set('sslmode', 'disable');
      url.searchParams.delete('sslrootcert');
      const database = createDatabase(url.href);
      let rejected = false;
      try { await database.check(); } catch { rejected = true; }
      finally { await database.close(); }
      if (!rejected) throw new Error('Database TLS policy bypass');
    `,
    );
  }

  const html = (await request(web + "/")).body.toString();
  assert.match(html, /<div id="root"><\/div>/);
  for (const path of [
    "/index.html",
    "/history",
    "/auth/sign-in",
    "/rooms/join",
    `/games/${randomUUID()}`,
    "/unknown-route",
  ]) {
    const response = await request(web + path);
    assert.equal(response.status, 200);
    assert.equal(response.body.toString(), html);
    assert.equal(response.headers["cache-control"], "no-cache");
  }
  for (const path of ["/assets/missing.js", "/engines/missing.wasm"]) {
    for (const accept of ["text/html", "*/*"]) {
      assert.equal((await request(web + path, { headers: { accept } })).status, 404);
    }
  }
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map(
    (match) => match[1],
  );
  assert(assets.length > 1);
  for (const path of assets) {
    const response = await request(web + path);
    assert.equal(response.status, 200);
    assert.match(
      response.headers["content-type"],
      path.endsWith("js") ? /javascript/ : /text\/css/,
    );
    assert.match(response.headers["cache-control"], /immutable/);
  }
  const engineRoot = web + "/engines/sf19-lite-single-v1/";
  const manifest = (await request(engineRoot + "manifest.json")).json();
  for (const path of [...Object.keys(manifest.files), "index.html", "REBUILD.md"]) {
    const response = await request(engineRoot + path);
    assert.equal(response.status, 200, `Engine distribution ${path}`);
    if (path.endsWith(".wasm")) assert.match(response.headers["content-type"], /application\/wasm/);
  }
  for (const path of ["/games/" + randomUUID(), "/__test__/mail", "/arena-reference", "/sandbox"]) {
    const response = await request(api + path, { headers: { accept: "text/html" } });
    assert([401, 403, 404].includes(response.status));
    assert.match(response.headers["content-type"], /application\/json/);
  }
  step(
    "Static routes, MIME types, cache policy, engine/source distribution and API separation passed.",
  );

  const email = "rehearsal@example.com";
  await post("/api/auth/sign-up/email", { email, password });
  let verification;
  await until(async () => {
    const mail = await (await fetch("http://127.0.0.1:1026")).text();
    verification = mail
      .replaceAll(/=\r\n/g, "")
      .replaceAll("=3D", "=")
      .match(/https:\/\/localhost:8444\/api\/auth\/verify-email\?token=[^\s]+/)?.[0];
    return Boolean(verification);
  }, "TLS SMTP delivery failed");
  const verified = await request(verification);
  assert.equal(verified.status, 303);
  assert(verified.headers.location.startsWith(web + "/"));
  const signIn = await post("/api/auth/sign-in/email", { email, password });
  const accountCookie = cookieFrom(signIn);
  assert(
    signIn.headers["set-cookie"].some(
      (value) => /Secure/i.test(value) && /HttpOnly/i.test(value) && /SameSite=Lax/i.test(value),
    ),
  );
  await post("/profile/onboarding", { username: "Rehearsal" }, accountCookie);
  const operation = (await post("/rooms/creation-operation", {}, accountCookie)).json();
  const issued = (
    await post("/rooms", { operationId: operation.operationId, ownerColor: "white" }, accountCookie)
  ).json();
  const guest = await post("/guest-session", {});
  const guestCookie = cookieFrom(guest);
  const joined = (
    await post(
      "/rooms/join",
      { invitation: issued.invitation, commandId: randomUUID() },
      guestCookie,
    )
  ).json();
  const gameId = joined.snapshot.gameId;

  async function socketSnapshot() {
    const socket = new WebSocket(api.replace("https:", "wss:") + "/rooms/realtime", {
      ca,
      headers: { origin: web, cookie: guestCookie },
    });
    sockets.push(socket);
    const snapshot = new Promise((resolveSnapshot, reject) => {
      const timer = setTimeout(() => reject(new Error("Missing socket snapshot")), 10_000);
      socket.on("error", reject);
      socket.on("message", (bytes) => {
        const frame = JSON.parse(bytes.toString());
        if (frame.type === "snapshot") {
          clearTimeout(timer);
          resolveSnapshot(frame.room.snapshot);
        }
      });
    });
    await once(socket, "open");
    socket.send(
      JSON.stringify({ protocol: 1, type: "subscribe", gameId, expectedIdentity: "guest" }),
    );
    return { socket, snapshot: await snapshot };
  }
  assert.equal((await socketSnapshot()).snapshot.state, "active");
  await post(
    `/games/${gameId}/moves`,
    { gameId, expectedVersion: joined.snapshot.version, commandId: randomUUID(), move: "e2e4" },
    accountCookie,
  );

  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch();
    browsers.push(browser);
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addCookies(
      guestCookie.split("; ").map((cookie) => {
        const split = cookie.indexOf("=");
        return {
          name: cookie.slice(0, split),
          value: cookie.slice(split + 1),
          domain: "localhost",
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Strict",
        };
      }),
    );
    const page = await context.newPage();
    const wasm = page.waitForResponse(
      (response) => response.url().endsWith(".wasm") && response.status() === 200,
    );
    await page.goto(web + `/games/${gameId}`);
    await page.getByRole("grid").waitFor();
    await page.getByTestId("room-connection").filter({ hasText: "Room connected" }).waitFor();
    await wasm;
    await page.getByTestId("evaluation-score").waitFor();
    await until(
      async () => (await request(api + `/rooms/${gameId}`, { cookie: guestCookie })).status === 200,
      "Private room lost",
    );
    await context.close();
    step(`Production room, cookie, socket and worker loading: ${name}.`);
  }
  step("Stopping the sole API owner, migrating populated state, and restarting.");
  await compose("stop", "api");
  const stopped = JSON.parse(await command("docker", ["inspect", project + "-api"]));
  assert.equal(stopped[0].State.Running, false);
  assert.equal(stopped[0].State.ExitCode, 0);
  await compose("run", "--rm", "migrate");
  await compose("up", "-d", "--wait", "api");
  const recovered = (await socketSnapshot()).snapshot;
  assert.equal(recovered.state, "active");
  assert.equal(recovered.moves[0].uci, "e2e4");
  assert.equal(
    (await request(api + "/api/auth/get-session", { cookie: accountCookie })).status,
    200,
  );
  await compose("stop", "postgres");
  await until(
    async () => (await request(api + "/ready")).status === 503,
    "Database failure was not reported",
  );
  assert.equal((await request(api + "/health")).status, 200);
  await compose("up", "-d", "--wait", "postgres");
  await until(
    async () => (await request(api + "/ready")).status === 200,
    "Database recovery was not reported",
  );
  if (process.env.DEPLOY_ROLLBACK_API_IMAGE) {
    await compose("stop", "api");
    const deploymentFile = join(directory, "deploy.env");
    const original = await readFile(deploymentFile, "utf8");
    await writeFile(
      deploymentFile,
      original.replace(
        `API_IMAGE=${apiImage}`,
        `API_IMAGE=${process.env.DEPLOY_ROLLBACK_API_IMAGE}`,
      ),
    );
    await compose("up", "-d", "--wait", "api");
    const rollback = (await socketSnapshot()).snapshot;
    assert.equal(rollback.state, "active");
    assert.equal(rollback.moves[0].uci, "e2e4");
    assert((await request(api + "/api/auth/get-session", { cookie: accountCookie })).json().user);
    await compose("stop", "api");
    await writeFile(deploymentFile, original);
    await compose("up", "-d", "--wait", "api");
    assert.equal((await socketSnapshot()).snapshot.moves[0].uci, "e2e4");
    step(
      "Previous API image rollback and return to the new image preserved populated state and sessions.",
    );
  }
  step("Checking real proxy enforcement against forged client addresses.");
  let authLimited = false;
  for (let attempt = 0; attempt < 65; attempt++) {
    const response = await request(api + "/api/auth/get-session", {
      headers: {
        "x-forwarded-for": `192.0.2.${attempt + 1}`,
        "x-neurochess-client-ip": `198.51.100.${attempt + 1}`,
        forwarded: `for=192.0.2.${attempt + 1}`,
      },
    });
    if (response.status === 429) {
      assert.equal(response.json().code, "AUTH_RATE_LIMITED");
      assert(Number(response.headers["retry-after"]) > 0);
      authLimited = true;
      break;
    }
    assert.equal(response.status, 200);
  }
  assert(authLimited, "Forged headers bypassed the auth IP limit through Caddy");
  const invitation = randomBytes(32).toString("base64url");
  let invitationLimited = false;
  for (let attempt = 0; attempt < 35; attempt++) {
    const response = await request(api + "/rooms/invitations/resolve", {
      method: "POST",
      data: { invitation },
      headers: { "x-forwarded-for": `203.0.113.${attempt + 1}` },
    });
    if (response.status === 429) {
      assert.equal(response.json().code, "RATE_LIMITED");
      assert.equal(response.headers["cache-control"], "no-store");
      assert(Number(response.headers["retry-after"]) > 0);
      assert.match(response.headers["access-control-expose-headers"], /Retry-After/i);
      invitationLimited = true;
      break;
    }
    assert.equal(response.status, 200);
  }
  assert(invitationLimited, "Forged headers bypassed the HTTP IP limit through Caddy");
  assert.equal((await socketSnapshot()).snapshot.state, "active");
  assert.equal((await request(api + `/rooms/${gameId}`, { cookie: guestCookie })).status, 200);
  step("Production rehearsal passed; no live infrastructure was provisioned.");
} finally {
  for (const socket of sockets) socket.terminate();
  await Promise.all(browsers.map((browser) => browser.close()));
  try {
    if (configured) await compose("down", "--volumes", "--remove-orphans");
  } finally {
    assert.equal(dirname(directory), tmpdir());
    assert(basename(directory).startsWith("neurochess-deployment-"));
    await rm(directory, { recursive: true, force: true });
  }
}
