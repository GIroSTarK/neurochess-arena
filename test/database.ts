import { createDatabase } from "@neurochess/database";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

export function testDatabaseUrl(): string {
  try {
    loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      // eslint-disable-next-line preserve-caught-error -- Raw environment errors must not enter test output.
      throw new Error("Could not load the integration test environment");
    }
  }
  // Never fall back to DATABASE_URL: tests must explicitly target a disposable database.
  return parseTestDatabaseUrl(process.env.TEST_DATABASE_URL);
}

export function parseTestDatabaseUrl(value: unknown): string {
  try {
    if (typeof value !== "string") throw new Error();
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !/^\/[a-z0-9_]+_test$/.test(url.pathname) ||
      url.searchParams.has("options")
    )
      throw new Error();
    return value;
  } catch {
    throw new Error(
      "TEST_DATABASE_URL must explicitly name a disposable PostgreSQL database ending in _test (without options)",
    );
  }
}

export function integrationDatabase() {
  return createDatabase(testDatabaseUrl());
}
