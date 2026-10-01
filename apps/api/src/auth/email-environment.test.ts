import { describe, expect, it } from "vitest";

import { parseApiEnvironment } from "../env.js";

const base = {
  NODE_ENV: "production",
  WEB_ORIGIN: "https://arena.example.com",
  BETTER_AUTH_URL: "https://api.example.com",
  BETTER_AUTH_SECRET: "smtp-environment-fixture-secret-only",
  DATABASE_URL: "postgresql://localhost/neurochess",
};
const smtp = {
  AUTH_EMAIL_TRANSPORT: "smtp",
  AUTH_EMAIL_FROM: "accounts@example.com",
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_SECURITY: "starttls",
  SMTP_USER: "smtp-user",
  SMTP_PASSWORD: "smtp-password-canary",
};

describe("authentication email environment", () => {
  it("requires explicit usable mail configuration in production", () => {
    expect(() => parseApiEnvironment(base)).toThrow("AUTH_EMAIL_TRANSPORT");
    expect(() => parseApiEnvironment({ ...base, AUTH_EMAIL_TRANSPORT: "memory" })).toThrow(
      "AUTH_EMAIL_TRANSPORT",
    );
    expect(parseApiEnvironment({ ...base, ...smtp })).toMatchObject({
      SMTP_PORT: 587,
      SMTP_SECURITY: "starttls",
    });
  });

  it("keeps unconfigured email flows disabled only outside production", () => {
    expect(parseApiEnvironment({ ...base, NODE_ENV: "development" })).toMatchObject({
      AUTH_EMAIL_TRANSPORT: "disabled",
    });
  });

  it.each([
    ["AUTH_EMAIL_FROM", undefined],
    ["AUTH_EMAIL_FROM", "sender@example.com\r\nBcc: victim@example.com"],
    ["SMTP_HOST", undefined],
    ["SMTP_HOST", "smtp://user:secret@example.com"],
    ["SMTP_PORT", "0"],
    ["SMTP_PORT", "65536"],
    ["SMTP_PASSWORD", undefined],
    ["SMTP_USER", undefined],
    ["SMTP_SECURITY", "none"],
  ])("rejects invalid %s without disclosing values", (key, value) => {
    expect(() => parseApiEnvironment({ ...base, ...smtp, [key]: value })).toThrow(key);
    try {
      parseApiEnvironment({ ...base, ...smtp, [key]: value });
    } catch (error) {
      expect((error as Error).message).not.toContain("canary");
    }
  });

  it("allows unauthenticated plaintext SMTP only on a local development/test loopback", () => {
    const local = {
      ...base,
      ...smtp,
      NODE_ENV: "test",
      SMTP_HOST: "127.0.0.1",
      SMTP_SECURITY: "none",
      SMTP_USER: undefined,
      SMTP_PASSWORD: undefined,
    };
    expect(parseApiEnvironment(local)).toMatchObject({ SMTP_SECURITY: "none" });
    expect(() => parseApiEnvironment({ ...local, SMTP_HOST: "smtp.example.com" })).toThrow(
      "SMTP_SECURITY",
    );
  });
});
