import { randomUUID } from "node:crypto";

import { expect, it } from "vitest";

import { buildApp } from "../app.js";
import { createLoggerOptions } from "../logger.js";

it("rejects a stale profile page before reading or updating a different cookie account", async () => {
  let calls = 0;
  const userId = randomUUID();
  const profile = {
    username: "Player",
    completed: true,
    avatar: { source: "initials" as const, initials: "PL" },
  };
  const app = await buildApp({
    readiness: { check: async () => undefined },
    webOrigin: "http://localhost:5173",
    auth: {
      baseURL: "http://localhost:3001",
      handle: async () => new Response(),
      resolve: async () => ({ kind: "account", userId, sessionId: randomUUID() }),
    },
    profiles: {
      read: async () => {
        calls++;
        return profile;
      },
      update: async () => {
        calls++;
        return profile;
      },
    },
  });
  try {
    for (const method of ["GET", "POST"] as const) {
      const response = await app.inject({
        method,
        url: "/profile",
        headers: { origin: "http://localhost:5173", "x-neurochess-expected-account": randomUUID() },
        ...(method === "POST" ? { payload: { username: "NewName" } } : {}),
      });
      expect(response.statusCode).toBe(401);
    }
    expect(calls).toBe(0);
  } finally {
    await app.close();
  }
});

it("contains profile repository failures without logging input, session or database details", async () => {
  const logs: string[] = [];
  const fail = async (): Promise<never> => {
    throw new Error("database-secret-canary profile-input-canary");
  };
  const app = await buildApp({
    readiness: { check: async () => undefined },
    webOrigin: "http://localhost:5173",
    logger: {
      ...createLoggerOptions("info"),
      stream: { write: (chunk: string) => logs.push(chunk) },
    },
    auth: {
      baseURL: "http://localhost:3001",
      handle: async () => new Response(),
      resolve: async () => ({ kind: "account", userId: randomUUID(), sessionId: randomUUID() }),
    },
    profiles: { read: fail, update: fail },
  });
  try {
    for (const method of ["GET", "POST"] as const) {
      const response = await app.inject({
        method,
        url: "/profile",
        headers: { origin: "http://localhost:5173", cookie: "session-token-canary" },
        ...(method === "POST" ? { payload: { username: "Valid" } } : {}),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "PROFILE_UNAVAILABLE" });
      expect(response.body).not.toContain("canary");
    }
    expect(logs.join("")).not.toContain("canary");
    expect(logs.join("")).toContain("profile_request_failed");
  } finally {
    await app.close();
  }
});
