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
