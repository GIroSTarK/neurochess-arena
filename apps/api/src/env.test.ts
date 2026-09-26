import { describe, expect, it } from "vitest";

import { EnvironmentValidationError, parseApiEnvironment } from "./env.js";

const validEnvironment = {
  NODE_ENV: "test",
  API_HOST: "127.0.0.1",
  API_PORT: "3001",
  WEB_ORIGIN: "http://localhost:5173",
  BETTER_AUTH_URL: "http://localhost:3001",
  BETTER_AUTH_SECRET: "test-only-auth-environment-secret-349829394",
  DATABASE_URL: "postgresql://user:password@localhost:5432/neurochess",
  LOG_LEVEL: "silent",
};

describe("parseApiEnvironment", () => {
  it("requires a valid bounded encryption keyring and active key together, without echoing values", () => {
    const key = Buffer.alloc(32, 17).toString("base64");
    const configuration = {
      CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: "test-v1",
      CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ "test-v1": key }),
    };
    expect(parseApiEnvironment({ ...validEnvironment, ...configuration })).toMatchObject({
      CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: "test-v1",
      CREDENTIAL_ENCRYPTION_KEYS: { "test-v1": key },
    });
    expect(parseApiEnvironment(validEnvironment).CREDENTIAL_ENCRYPTION_KEYS).toBeUndefined();
    for (const patch of [
      { CREDENTIAL_ENCRYPTION_KEYS: undefined },
      { CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: undefined },
      { CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: "missing" },
      { CREDENTIAL_ENCRYPTION_ACTIVE_KEY_ID: "" },
      { CREDENTIAL_ENCRYPTION_KEYS: "" },
      { CREDENTIAL_ENCRYPTION_KEYS: "secret-canary" },
      { CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ "test-v1": "secret-canary" }) },
      {
        CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({
          "test-v1": Buffer.alloc(31).toString("base64"),
        }),
      },
      { CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ "test-v1": key + "\n" }) },
      { CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ "test-v1": key.slice(0, -1) }) },
      { CREDENTIAL_ENCRYPTION_KEYS: "{}" },
      { CREDENTIAL_ENCRYPTION_KEYS: "[]" },
      {
        CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify(
          Object.fromEntries(Array.from({ length: 9 }, (_, n) => [`key${n}`, key])),
        ),
      },
      { CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ "bad/key": key, "test-v1": key }) },
    ]) {
      try {
        parseApiEnvironment({ ...validEnvironment, ...configuration, ...patch });
        expect.fail("Invalid encryption configuration accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(EnvironmentValidationError);
        expect(String(error)).not.toContain("secret-canary");
        expect(String(error)).not.toContain(key);
      }
    }
  });
  it.each(["GOOGLE", "GITHUB"])(
    "requires paired, bounded %s OAuth credentials without echoing secrets",
    (provider) => {
      const id = `${provider}_CLIENT_ID`;
      const secret = `${provider}_CLIENT_SECRET`;
      expect(parseApiEnvironment(validEnvironment)).not.toHaveProperty(id);
      expect(
        parseApiEnvironment({ ...validEnvironment, [id]: "client-id", [secret]: "secret-canary" }),
      ).toMatchObject({ [id]: "client-id" });
      for (const values of [
        { [id]: "client-id" },
        { [secret]: "secret-canary" },
        { [id]: "client-id", [secret]: "" },
        { [id]: "client-id", [secret]: "secret-canary\r\n" },
        { [id]: "client-id", [secret]: "x".repeat(513) },
        { [id]: "client-id/path", [secret]: "secret-canary" },
        { [id]: "client-id", [secret]: 123 },
      ]) {
        try {
          parseApiEnvironment({ ...validEnvironment, ...values });
          expect.fail("Invalid OAuth configuration accepted");
        } catch (error) {
          expect(error).toBeInstanceOf(EnvironmentValidationError);
          expect(String(error).includes("secret-canary")).toBe(false);
        }
      }
    },
  );
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
        WEB_ORIGIN: "https://arena.example.test",
        BETTER_AUTH_URL: "https://api.example.test",
        AUTH_EMAIL_TRANSPORT: "smtp",
        AUTH_EMAIL_FROM: "auth@example.test",
        SMTP_HOST: "smtp.example.test",
      }).SANDBOX_ENABLED,
    ).toBe(false);
  });

  it.each(["BETTER_AUTH_URL", "WEB_ORIGIN"])("requires an exact safe origin for %s", (key) => {
    for (const value of [
      "https://user:secret@example.test",
      "https://example.test/path",
      "https://example.test?token=canary",
      "https://example.test/#fragment",
      "https://*.example.test",
      "https://example.test/",
      "ftp://example.test",
      "http://example.test",
      "http://127.0.0.1:3001",
    ]) {
      expect(() => parseApiEnvironment({ ...validEnvironment, [key]: value })).toThrow(key);
    }
    expect(() => parseApiEnvironment({ ...validEnvironment, NODE_ENV: "production" })).toThrow(key);
  });

  it.each([undefined, "", "auth-secret-canary", " ".repeat(32), "x".repeat(257)])(
    "requires an auth secret without echoing it",
    (BETTER_AUTH_SECRET) => {
      expect(() => parseApiEnvironment({ ...validEnvironment, BETTER_AUTH_SECRET })).toThrow(
        "BETTER_AUTH_SECRET",
      );
      try {
        parseApiEnvironment({ ...validEnvironment, BETTER_AUTH_SECRET });
      } catch (error) {
        expect(String(error)).not.toContain("auth-secret-canary");
      }
    },
  );

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

  it("requires configured SMTP in production and never selects a test mailbox from the environment", () => {
    const production = {
      ...validEnvironment,
      NODE_ENV: "production",
      WEB_ORIGIN: "https://arena.example.test",
      BETTER_AUTH_URL: "https://api.example.test",
    };
    for (const AUTH_EMAIL_TRANSPORT of [undefined, "disabled", "test", "memory"]) {
      expect(() => parseApiEnvironment({ ...production, AUTH_EMAIL_TRANSPORT })).toThrow(
        "AUTH_EMAIL_TRANSPORT",
      );
    }
    const smtp = {
      ...production,
      AUTH_EMAIL_TRANSPORT: "smtp",
      AUTH_EMAIL_FROM: "accounts@example.test",
      SMTP_HOST: "smtp.example.test",
    };
    expect(parseApiEnvironment(smtp)).toMatchObject({ SMTP_SECURITY: "starttls", SMTP_PORT: 587 });
    expect(() => parseApiEnvironment({ ...smtp, SMTP_SECURITY: "none" })).toThrow("SMTP_SECURITY");
    expect(parseApiEnvironment({ ...smtp, SMTP_SECURITY: "tls", SMTP_PORT: "465" }).SMTP_PORT).toBe(
      465,
    );
  });

  it("validates sender, host, port, encryption, and paired SMTP credentials without echoing secrets", () => {
    const smtp = {
      ...validEnvironment,
      AUTH_EMAIL_TRANSPORT: "smtp",
      AUTH_EMAIL_FROM: "auth@example.test",
      SMTP_HOST: "localhost",
      SMTP_SECURITY: "none",
      SMTP_PORT: "1025",
    };
    expect(parseApiEnvironment(smtp).SMTP_SECURITY).toBe("none");
    for (const invalid of [
      { AUTH_EMAIL_FROM: undefined },
      { AUTH_EMAIL_FROM: "auth@example.test\r\nBcc: attacker@example.test" },
      { SMTP_HOST: undefined },
      { SMTP_HOST: "smtp://user:secret-canary@example.test" },
      { SMTP_HOST: "smtp..example.test" },
      { SMTP_HOST: "smtp.example.test" },
      { SMTP_PORT: "0" },
      { SMTP_PORT: "65536" },
      { SMTP_SECURITY: "optional" },
      { SMTP_USER: "user-secret-canary" },
      { SMTP_PASSWORD: "password-secret-canary" },
    ]) {
      expect(() => parseApiEnvironment({ ...smtp, ...invalid })).toThrow(
        EnvironmentValidationError,
      );
      try {
        parseApiEnvironment({ ...smtp, ...invalid });
      } catch (error) {
        expect(String(error)).not.toContain("secret-canary");
      }
    }
  });
});
