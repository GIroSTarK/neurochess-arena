import { randomUUID } from "node:crypto";

import { expect, it } from "vitest";

import { buildApp } from "../app.js";
import { createLoggerOptions } from "../logger.js";

it("contains repository and crypto exceptions and masks unknown credential paths", async () => {
  const logs: string[] = [];
  const fail = async (): Promise<never> => {
    throw new Error("input-key-canary decrypted-key-canary database-secret-canary");
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
    credentials: { save: fail, list: fail, revoke: fail, clear: fail },
  });
  try {
    const headers = { origin: "http://localhost:5173", cookie: "session-token-canary" };
    for (const [url, payload] of [
      [
        "/credentials",
        {
          credentialId: randomUUID(),
          save: true,
          label: "Work",
          provider: "openai",
          apiKey: "input-key-canary",
        },
      ],
      ["/credentials/revoke", { credentialId: randomUUID() }],
      ["/credentials/clear", { confirm: true }],
    ] as const) {
      const response = await app.inject({ method: "POST", url, headers, payload });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("canary");
    }
    expect((await app.inject({ url: "/credentials", headers })).statusCode).toBe(503);
    const response = await app.inject({ url: "/credentials/input-key-canary/reveal", headers });
    expect(response.statusCode).toBe(404);
    expect(response.body + logs.join("")).not.toContain("canary");
    expect(logs.join("")).toContain("credential_request_failed");
  } finally {
    await app.close();
  }
});
