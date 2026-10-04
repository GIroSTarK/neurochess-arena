import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const services = [];
const startup = new AbortController();

try {
  await Promise.all([
    requireAvailablePort("127.0.0.1", 3001),
    requireAvailablePort("localhost", 5173),
  ]);

  services.push(startService("api", [resolve("apps/api/dist/server.js")]));
  services.push(
    startService("web", [resolve("node_modules/vite/bin/vite.js"), "preview", "apps/web"]),
  );

  await Promise.all([
    waitForResponse(
      "http://127.0.0.1:3001/ready",
      (response) => response.status === 200,
      startup.signal,
    ),
    waitForResponse("http://localhost:5173", (response) => response.status === 200, startup.signal),
  ]);
  startup.signal.throwIfAborted();

  const webOrigin = "http://localhost:5173";
  const gameId = "00000000-0000-4000-8000-000000000001";
  const html = await checkWebDocument(webOrigin, "/");
  for (const path of [
    `/games/${gameId}`,
    `/sandbox/games/${gameId}`,
    "/history",
    "/account/credentials",
    "/auth/sign-in",
    "/unknown-route",
  ]) {
    assert.equal(await checkWebDocument(webOrigin, path), html, `SPA fallback at ${path}`);
  }
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)].map(
    (match) => match[1],
  );
  assert(
    assets.some((path) => path.endsWith(".js")),
    "Built HTML must load a script asset",
  );
  assert(
    assets.some((path) => path.endsWith(".css")),
    "Built HTML must load a stylesheet",
  );
  for (const path of assets) {
    const response = await request(
      webOrigin + path,
      path.endsWith(".js") ? "application/javascript" : "text/css",
    );
    assert.equal(response.status, 200, `Static asset at ${path}`);
    assert.match(
      response.headers.get("content-type") ?? "",
      path.endsWith(".js") ? /(?:java|ecma)script/ : /text\/css/,
      `Static asset type at ${path}`,
    );
  }
  const missing = await request(
    webOrigin + "/assets/missing-smoke-asset.js",
    "application/javascript",
  );
  assert.equal(missing.status, 404, "A non-HTML asset request must not receive the SPA fallback");
  for (const path of [
    `/games/${gameId}/details`,
    `/games/${gameId}`,
    `/sandbox/games/${gameId}`,
    "/unknown-route",
  ]) {
    const response = await request("http://127.0.0.1:3001" + path);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert([401, 403, 404].includes(response.status), `Private or unknown API route at ${path}`);
    assert.equal(typeof (await response.json()).code, "string", `Bounded API error at ${path}`);
  }
  process.stdout.write(
    "Built API and web preview passed startup, deep-link HTML fallback, static asset and JSON-origin smoke checks.\n",
  );
} catch (error) {
  for (const service of services) {
    if (service.output.length > 0) {
      process.stderr.write(`\n${service.name} output:\n${service.output.join("")}\n`);
    }
  }
  throw error;
} finally {
  startup.abort();
  await Promise.all(services.map(stopService));
}

function request(url, accept = "text/html") {
  return fetch(url, {
    headers: { Accept: accept },
    redirect: "manual",
    signal: AbortSignal.any([startup.signal, AbortSignal.timeout(3_000)]),
  });
}

async function checkWebDocument(origin, path) {
  const response = await request(origin + path);
  assert.equal(response.status, 200, `Web document at ${path}`);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const html = await response.text();
  assert.match(html, /<div id="root"><\/div>/, `SPA document at ${path}`);
  return html;
}

async function requireAvailablePort(host, port) {
  const server = createServer();

  try {
    server.listen(port, host);
    await once(server, "listening");
  } catch (error) {
    throw new Error(`Smoke check port ${host}:${port} is unavailable`, { cause: error });
  } finally {
    if (server.listening) {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  }
}

function startService(name, arguments_) {
  const output = [];
  const child = spawn(process.execPath, arguments_, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const service = { child, name, output, stopping: false };

  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  child.once("error", (error) => {
    if (!service.stopping) {
      startup.abort(new Error(`${name} process failed`, { cause: error }));
    }
  });
  child.once("exit", (code, signal) => {
    if (!service.stopping) {
      const reason = signal === null ? `code ${code}` : `signal ${signal}`;
      startup.abort(new Error(`${name} exited before smoke checks completed (${reason})`));
    }
  });

  return service;
}

async function waitForResponse(url, accepts, signal) {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    signal.throwIfAborted();

    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1_500)]),
      });
      signal.throwIfAborted();
      if (accepts(response)) {
        return;
      }
    } catch {
      signal.throwIfAborted();
      // The service can refuse connections while its process is starting.
    }

    try {
      await delay(250, undefined, { signal });
    } catch {
      signal.throwIfAborted();
    }
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function stopService(service) {
  service.stopping = true;
  const { child } = service;

  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return;
  }

  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3_000, undefined, { ref: false })]);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}
