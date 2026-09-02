import { describe, expect, it } from "vitest";

import { EnvironmentValidationError, parseApiEnvironment } from "./env.js";

const validEnvironment = {
  NODE_ENV: "test",
  API_HOST: "127.0.0.1",
  API_PORT: "3001",
  WEB_ORIGIN: "http://localhost:5173",
  DATABASE_URL: "postgresql://user:password@localhost:5432/neurochess",
  LOG_LEVEL: "silent",
};

describe("parseApiEnvironment", () => {
  it("disables the sandbox by default and gives guests a 24-hour inactivity expiry", () => {
    expect(parseApiEnvironment(validEnvironment)).toMatchObject({
      SANDBOX_ENABLED: false,
      GUEST_SESSION_TTL_SECONDS: 86_400,
    });
  });

  it.each(["development", "test"])("allows explicit sandbox enablement in %s", (NODE_ENV) => {
    expect(
      parseApiEnvironment({ ...validEnvironment, NODE_ENV, SANDBOX_ENABLED: "true" })
        .SANDBOX_ENABLED,
    ).toBe(true);
  });

  it("rejects production enablement but accepts an explicitly disabled production sandbox", () => {
    expect(() =>
      parseApiEnvironment({ ...validEnvironment, NODE_ENV: "production", SANDBOX_ENABLED: "true" }),
    ).toThrow("SANDBOX_ENABLED");
    expect(
      parseApiEnvironment({ ...validEnvironment, NODE_ENV: "production", SANDBOX_ENABLED: "false" })
        .SANDBOX_ENABLED,
    ).toBe(false);
  });

  it.each(["TRUE", "1", "yes", "", true, 1])(
    "rejects ambiguous sandbox flags: %j",
    (SANDBOX_ENABLED) => {
      expect(() => parseApiEnvironment({ ...validEnvironment, SANDBOX_ENABLED })).toThrow(
        "SANDBOX_ENABLED",
      );
    },
  );

  it.each(["0", "-1", "1.5", "", "31536001", "secret-canary"])(
    "rejects invalid guest expiry: %s",
    (GUEST_SESSION_TTL_SECONDS) => {
      expect(() => parseApiEnvironment({ ...validEnvironment, GUEST_SESSION_TTL_SECONDS })).toThrow(
        "GUEST_SESSION_TTL_SECONDS",
      );
    },
  );

  it("coerces and validates the public API configuration", () => {
    expect(parseApiEnvironment(validEnvironment)).toMatchObject({
      API_PORT: 3001,
      DATABASE_URL: validEnvironment.DATABASE_URL,
      NODE_ENV: "test",
    });
  });

  it("names invalid variables without exposing their values", () => {
    const canary = "https://phase-zero-canary-secret.example";

    expect(() =>
      parseApiEnvironment({ ...validEnvironment, API_PORT: "not-a-port", DATABASE_URL: canary }),
    ).toThrow(EnvironmentValidationError);

    try {
      parseApiEnvironment({ ...validEnvironment, API_PORT: "not-a-port", DATABASE_URL: canary });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect((error as Error).message).toContain("API_PORT");
      expect((error as Error).message).toContain("DATABASE_URL");
      expect((error as Error).message).not.toContain(canary);
    }
  });
});
