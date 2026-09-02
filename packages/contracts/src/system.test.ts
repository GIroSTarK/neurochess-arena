import { describe, expect, it } from "vitest";

import {
  healthResponseSchema,
  readinessResponseSchema,
  safeErrorResponseSchema,
} from "./system.js";

describe("system contracts", () => {
  it("accepts the documented health and readiness responses", () => {
    expect(healthResponseSchema.parse({ status: "ok" })).toEqual({ status: "ok" });
    expect(readinessResponseSchema.parse({ status: "ready" })).toEqual({ status: "ready" });
    expect(readinessResponseSchema.parse({ status: "not_ready" })).toEqual({
      status: "not_ready",
    });
  });

  it("rejects response fields that are not part of the public contract", () => {
    expect(() => healthResponseSchema.parse({ status: "ok", databaseUrl: "secret" })).toThrow();
  });

  it("requires a safe request identifier on error responses", () => {
    expect(
      safeErrorResponseSchema.safeParse({ code: "NOT_FOUND", message: "Not found" }).success,
    ).toBe(false);
  });
});
