import { describe, expect, it } from "vitest";

import {
  emptyQuerySchema,
  gameParamsSchema,
  guestSessionRequestSchema,
  guestSessionResponseSchema,
} from "./index.js";

describe("guest HTTP contracts", () => {
  it("accepts only empty bootstrap requests and query strings", () => {
    for (const schema of [guestSessionRequestSchema, emptyQuerySchema]) {
      expect(schema.parse({})).toEqual({});
      for (const input of [
        null,
        undefined,
        [],
        { guestId: "spoof" },
        { fen: "spoof" },
        { sandbox: true },
      ]) {
        expect(schema.safeParse(input).success).toBe(false);
      }
    }
  });

  it("exposes no session identifier or token in bootstrap responses", () => {
    expect(guestSessionResponseSchema.parse({ status: "ready" })).toEqual({ status: "ready" });
    expect(guestSessionResponseSchema.safeParse({ status: "ready", token: "secret" }).success).toBe(
      false,
    );
  });

  it("requires exactly one UUID route parameter", () => {
    const gameId = "10000000-0000-4000-8000-000000000001";
    expect(gameParamsSchema.parse({ gameId })).toEqual({ gameId });
    expect(gameParamsSchema.safeParse({ gameId: "unknown" }).success).toBe(false);
    expect(gameParamsSchema.safeParse({ gameId, guestId: gameId }).success).toBe(false);
  });
});
