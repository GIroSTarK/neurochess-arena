import { describe, expect, it } from "vitest";

import { EnvironmentValidationError, parseApiEnvironment } from "./env.js";

const validEnvironment = {
  NODE_ENV: "test",
  API_HOST: "127.0.0.1",
  API_PORT: "3001",
  WEB_ORIGIN: "http://localhost:5173",
  DATABASE_URL: "postgresql://user:password@localhost:5432/neurochess?sslmode=verify-full",
  LOG_LEVEL: "silent",
  BETTER_AUTH_URL: "http://localhost:3001",
  BETTER_AUTH_SECRET: "fixture-only-auth-secret-with-at-least-32-characters",
  AUTH_EMAIL_TRANSPORT: "smtp",
  AUTH_EMAIL_FROM: "accounts@example.com",
  SMTP_HOST: "smtp.example.com",
  TRUSTED_PROXY_IP: "172.30.0.2",
};

describe("parseApiEnvironment", () => {
  it("requires one exact proxy IP in production and rejects wildcard trust", () => {
    const production = {
      ...validEnvironment,
      NODE_ENV: "production",
      WEB_ORIGIN: "https://arena.example.com",
      BETTER_AUTH_URL: "https://api.example.com",
    };
    for (const value of [
      undefined,
      "",
      "true",
      "172.30.0.0/24",
      "172.30.0.2,172.30.0.3",
      "fe80::1%eth0",
    ]) {
      expect(() => parseApiEnvironment({ ...production, TRUSTED_PROXY_IP: value })).toThrow(
        "TRUSTED_PROXY_IP",
      );
    }
    expect(parseApiEnvironment(production).TRUSTED_PROXY_IP).toBe("172.30.0.2");
    expect(
      parseApiEnvironment({ ...validEnvironment, TRUSTED_PROXY_IP: undefined }).TRUSTED_PROXY_IP,
    ).toBeUndefined();
  });
  it("rejects cross-site production origins including unrelated private suffix tenants", () => {
    const production = {
      ...validEnvironment,
      NODE_ENV: "production",
      WEB_ORIGIN: "https://arena.example.com",
      BETTER_AUTH_URL: "https://api.example.net",
    };
    expect(() => parseApiEnvironment(production)).toThrow("WEB_ORIGIN");
    expect(() =>
      parseApiEnvironment({
        ...production,
        WEB_ORIGIN: "https://arena.github.io",
        BETTER_AUTH_URL: "https://api.github.io",
      }),
    ).toThrow("WEB_ORIGIN");
  });

  it("rejects global TLS verification bypass in production", () => {
    expect(() =>
      parseApiEnvironment({
        ...validEnvironment,
        NODE_ENV: "production",
        WEB_ORIGIN: "https://arena.example.com",
        BETTER_AUTH_URL: "https://api.example.com",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      }),
    ).toThrow("NODE_TLS_REJECT_UNAUTHORIZED");
  });
  it.each([undefined, "", "short-secret-canary", " ".repeat(40)])(
    "requires an explicit auth secret without disclosing invalid values",
    (BETTER_AUTH_SECRET) => {
      expect(() => parseApiEnvironment({ ...validEnvironment, BETTER_AUTH_SECRET })).toThrow(
        "Invalid environment variables: BETTER_AUTH_SECRET",
      );
    },
  );

  it.each(["WEB_ORIGIN", "BETTER_AUTH_URL"])("validates %s as an explicit safe origin", (key) => {
    for (const value of [
      "https://user:secret@example.com",
      "https://example.com/path",
      "https://example.com?token=secret",
      "https://example.com#secret",
      "https://*.example.com",
      "ftp://example.com",
      "http://example.com",
    ]) {
      expect(() => parseApiEnvironment({ ...validEnvironment, [key]: value })).toThrow(key);
    }
  });

  it("requires an auth URL and HTTPS origins in production", () => {
    expect(() => parseApiEnvironment({ ...validEnvironment, BETTER_AUTH_URL: undefined })).toThrow(
      "BETTER_AUTH_URL",
    );
    expect(() => parseApiEnvironment({ ...validEnvironment, NODE_ENV: "production" })).toThrow(
      "Invalid environment variables: BETTER_AUTH_URL, WEB_ORIGIN",
    );
    expect(
      parseApiEnvironment({
        ...validEnvironment,
        NODE_ENV: "production",
        WEB_ORIGIN: "https://arena.example.com",
        BETTER_AUTH_URL: "https://api.example.com",
      }).BETTER_AUTH_URL,
    ).toBe("https://api.example.com");
  });

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
      parseApiEnvironment({
        ...validEnvironment,
        NODE_ENV: "production",
        SANDBOX_ENABLED: "false",
        WEB_ORIGIN: "https://arena.example.com",
        BETTER_AUTH_URL: "https://api.example.com",
      }).SANDBOX_ENABLED,
    ).toBe(false);
  });

  it.each([
    { name: "uppercase string", SANDBOX_ENABLED: "TRUE" },
    { name: "numeric string", SANDBOX_ENABLED: "1" },
    { name: "affirmative string", SANDBOX_ENABLED: "yes" },
    { name: "empty string", SANDBOX_ENABLED: "" },
    { name: "boolean", SANDBOX_ENABLED: true },
    { name: "number", SANDBOX_ENABLED: 1 },
  ])("rejects ambiguous sandbox flag: $name", ({ SANDBOX_ENABLED }) => {
    expect(() => parseApiEnvironment({ ...validEnvironment, SANDBOX_ENABLED })).toThrow(
      "SANDBOX_ENABLED",
    );
  });

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
