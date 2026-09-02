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
    startService("web", [
      resolve("node_modules/vite/bin/vite.js"),
      "preview",
      "apps/web",
      "--host",
      "localhost",
      "--port",
      "5173",
      "--strictPort",
    ]),
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

  process.stdout.write("Built API and web preview passed startup smoke checks.\n");
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
