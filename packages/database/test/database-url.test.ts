import { describe, expect, it } from "vitest";

import { parseDatabaseUrl } from "../src/database-url.js";

describe("production database configuration", () => {
  const base = "postgresql://arena:secret-canary@database.example.com:5432/arena";

  it("requires certificate and hostname verification in production", () => {
    for (const suffix of [
      "",
      "?sslmode=disable",
      "?sslmode=require",
      "?sslmode=verify-ca",
      "?sslmode=no-verify",
    ]) {
      expect(() => parseDatabaseUrl(base + suffix, true)).toThrow(
        "Invalid environment variables: DATABASE_URL",
      );
    }
  });

  it("rejects ambiguous TLS options without revealing connection credentials", () => {
    for (const suffix of [
      "?sslmode=verify-full&sslmode=disable",
      "?sslmode=disable&sslmode=verify-full",
      "?sslmode=verify-full&ssl=0",
      "?sslmode=verify-full&uselibpqcompat=true",
    ]) {
      expect(() => parseDatabaseUrl(base + suffix, true)).toThrow(
        "Invalid environment variables: DATABASE_URL",
      );
    }
  });

  it("accepts verified TLS with an optional mounted CA and preserves local development", () => {
    for (const suffix of [
      "?sslmode=verify-full",
      "?sslmode=verify-full&sslrootcert=/run/secrets/postgres-ca.pem",
    ]) {
      expect(parseDatabaseUrl(base + suffix, true)).toBe(base + suffix);
    }
    expect(parseDatabaseUrl("postgresql://localhost/arena")).toBe("postgresql://localhost/arena");
  });
});
