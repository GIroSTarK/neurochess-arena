import { describe, expect, it } from "vitest";

import { parseSandboxFlag, parseWebEnvironment, WebEnvironmentValidationError } from "./env";

describe("sandbox build flag", () => {
  it.each([
    [undefined, "false"],
    ["false", "false"],
    ["true", "true"],
  ])("exposes only an explicitly validated string (%s)", (input, expected) => {
    expect(parseSandboxFlag(input)).toBe(expected);
  });

  it("rejects a misconfigured value before it can enter the browser bundle", () => {
    expect(() => parseSandboxFlag("private-canary")).toThrow(WebEnvironmentValidationError);
    expect(() => parseSandboxFlag("private-canary")).toThrow("INVALID_WEB_ENVIRONMENT");
  });
});

describe("parseWebEnvironment", () => {
  it("accepts only public configuration and disables the sandbox by default", () => {
    expect(
      parseWebEnvironment({
        DATABASE_URL: "must-not-be-exposed",
        VITE_API_BASE_URL: "http://localhost:3001",
      }),
    ).toEqual({ VITE_API_BASE_URL: "http://localhost:3001", SANDBOX_ENABLED: false });
  });

  it.each(["true", "false"])("parses the shared sandbox flag %s", (value) => {
    expect(
      parseWebEnvironment({ VITE_API_BASE_URL: "http://localhost:3001", SANDBOX_ENABLED: value }),
    ).toEqual({ VITE_API_BASE_URL: "http://localhost:3001", SANDBOX_ENABLED: value === "true" });
  });

  it.each(["", "TRUE", "1", true, null, "private-canary"])(
    "rejects a malformed sandbox flag without disclosing its value (%s)",
    (value) => {
      try {
        parseWebEnvironment({ VITE_API_BASE_URL: "http://localhost:3001", SANDBOX_ENABLED: value });
        throw new Error("Expected environment parsing to fail");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(WebEnvironmentValidationError);
        expect((error as WebEnvironmentValidationError).variables).toEqual(["SANDBOX_ENABLED"]);
        expect((error as Error).message).toBe("INVALID_WEB_ENVIRONMENT");
      }
    },
  );

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
