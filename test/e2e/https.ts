import { readFileSync } from "node:fs";
import { createServer } from "node:https";

import type { FastifyServerFactory } from "fastify";

// Public, test-only localhost material; never use these credentials for deployment.
export const testTls = {
  cert: readFileSync(new URL("./certificates/localhost-cert.pem", import.meta.url)),
  key: readFileSync(new URL("./certificates/localhost-key.pem", import.meta.url)),
};

// A factory rather than Fastify's `https` option keeps buildApp's HTTP instance type, while
// Fastify still owns listening, client errors, WebSocket upgrades and shutdown.
export const testApiServerFactory: FastifyServerFactory = (handler) =>
  createServer(testTls, handler);
