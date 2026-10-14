import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { expect, it } from "vitest";

import { createDatabase } from "../src/client.js";

it("readiness fails when an established PostgreSQL connection stops answering queries", async () => {
  const sockets = new Set<Socket>();
  let queryReceived = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("data", () => {
      // Minimal successful PostgreSQL startup followed by a deliberately stalled SELECT.
      socket.write(Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73]));
      socket.once("data", () => {
        queryReceived = true;
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  const database = createDatabase(`postgresql://fixture:fixture@127.0.0.1:${address.port}/fixture`);
  try {
    const result = await Promise.race([
      database.check().then(
        () => "ready",
        () => "unavailable",
      ),
      delay(5_500, "unbounded"),
    ]);
    expect(queryReceived).toBe(true);
    expect(result).toBe("unavailable");
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
    await database.close();
  }
}, 10_000);

it("readiness fails within its connection deadline when PostgreSQL accepts TCP but stalls", async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  const database = createDatabase(`postgresql://fixture:fixture@127.0.0.1:${address.port}/fixture`);
  try {
    const result = await Promise.race([
      database.check().then(
        () => "ready",
        () => "unavailable",
      ),
      delay(5_500, "unbounded"),
    ]);
    expect(result).toBe("unavailable");
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
    await database.close();
  }
}, 10_000);
