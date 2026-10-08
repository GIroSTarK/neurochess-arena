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
  it.each([
    "https://api.example.test",
    "https://api.example.test:8443/",
    "http://localhost:3001",
    "http://localhost/",
  ])("accepts HTTPS or the explicit HTTP localhost exception: %s", (value) => {
    expect(parseWebEnvironment({ VITE_API_BASE_URL: value }).VITE_API_BASE_URL).toBe(value);
  });

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

  it.each([
    { name: "empty string", value: "" },
    { name: "uppercase string", value: "TRUE" },
    { name: "numeric string", value: "1" },
    { name: "boolean", value: true },
    { name: "null", value: null },
    { name: "secret canary", value: "private-canary" },
  ])("rejects malformed sandbox flag: $name", ({ value }) => {
    try {
      parseWebEnvironment({ VITE_API_BASE_URL: "http://localhost:3001", SANDBOX_ENABLED: value });
      throw new Error("Expected environment parsing to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(WebEnvironmentValidationError);
      expect((error as WebEnvironmentValidationError).variables).toEqual(["SANDBOX_ENABLED"]);
      expect((error as Error).message).toBe("INVALID_WEB_ENVIRONMENT");
    }
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
    { name: "remote HTTP", value: "http://api.example.test" },
    { name: "LAN HTTP", value: "http://192.168.1.10:3001" },
    { name: "IPv4 loopback HTTP", value: "http://127.0.0.1:3001" },
    { name: "IPv6 loopback HTTP", value: "http://[::1]:3001" },
    { name: "localhost subdomain", value: "http://localhost.example.test" },
    { name: "non-HTTP protocol", value: "ftp://localhost" },
    { name: "embedded credentials", value: "https://user:secret@example.test" },
    { name: "non-root path", value: "https://example.test/path" },
    { name: "query string", value: "https://example.test?token=secret" },
    { name: "fragment", value: "https://example.test#secret" },
  ])("rejects invalid public API origin: $name", ({ value }) => {
    let failure: unknown;
    try {
      parseWebEnvironment({ VITE_API_BASE_URL: value });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WebEnvironmentValidationError);
    expect(failure).toMatchObject({
      message: "INVALID_WEB_ENVIRONMENT",
      variables: ["VITE_API_BASE_URL"],
    });
    expect(JSON.stringify(failure)).not.toContain(value);
  });
});
