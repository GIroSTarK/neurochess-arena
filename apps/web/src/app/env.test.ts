import { describe, expect, it } from "vitest";

import { parseWebEnvironment, WebEnvironmentValidationError } from "./env";

describe("parseWebEnvironment", () => {
  it("accepts only the public API base URL", () => {
    expect(
      parseWebEnvironment({
        DATABASE_URL: "must-not-be-exposed",
        VITE_API_BASE_URL: "http://localhost:3001",
      }),
    ).toEqual({ VITE_API_BASE_URL: "http://localhost:3001" });
  });

  it("identifies invalid variables without printing their values", () => {
    const canary = "phase-zero-web-secret";

    try {
      parseWebEnvironment({ VITE_API_BASE_URL: canary });
      throw new Error("Expected environment parsing to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(WebEnvironmentValidationError);
      expect((error as WebEnvironmentValidationError).variables).toEqual(["VITE_API_BASE_URL"]);
      expect((error as Error).message).not.toContain(canary);
    }
  });

  it.each([
    "ftp://localhost",
    "https://user:secret@example.test",
    "https://example.test/path",
    "https://example.test?token=secret",
    "https://example.test#secret",
  ])("rejects an API value that is not a public HTTP origin", (value) => {
    expect(() => parseWebEnvironment({ VITE_API_BASE_URL: value })).toThrow(
      WebEnvironmentValidationError,
    );
  });
});
