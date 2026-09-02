import { describe, expect, it } from "vitest";

import { parseTestDatabaseUrl } from "../../../test/database.js";

describe("integration database safety", () => {
  it("accepts only explicitly configured disposable test databases", () => {
    const url = "postgresql://example:placeholder@localhost:5433/neurochess_test";
    expect(parseTestDatabaseUrl(url)).toBe(url);
  });

  it.each([
    undefined,
    "",
    "postgresql://localhost/neurochess",
    "https://localhost/neurochess_test",
    "postgresql://localhost/neurochess_test?options=-csearch_path=public",
    "canary-secret",
  ])("rejects unsafe test configuration without leaking its value (%j)", (url) => {
    expect(() => parseTestDatabaseUrl(url)).toThrow("TEST_DATABASE_URL");
    try {
      parseTestDatabaseUrl(url);
    } catch (error) {
      expect((error as Error).message).not.toContain("canary-secret");
    }
  });
});
