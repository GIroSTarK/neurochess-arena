import { describe, expect, it } from "vitest";

import * as contracts from "./index.js";

const gameId = "10000000-0000-4000-8000-000000000001";
const subscribe = { protocol: 1, type: "subscribe", gameId, expectedIdentity: "guest" };

describe("private room realtime contracts", () => {
  it("requires a versioned identity expectation and rejects commands and extra authority", () => {
    expect(contracts.roomClientMessageSchema).toBeDefined();
    const schema = contracts.roomClientMessageSchema;
    expect(schema.parse(subscribe)).toEqual(subscribe);
    expect(schema.safeParse({ ...subscribe, expectedIdentity: gameId }).success).toBe(true);
    for (const patch of [
      { protocol: 2 },
      { protocol: "1" },
      { type: "move", move: "e2e4" },
      { gameId: "unknown" },
      { expectedIdentity: undefined },
      { expectedIdentity: "account" },
      { invitation: "secret" },
      { sessionToken: "secret" },
      { userId: gameId },
    ]) {
      expect(schema.safeParse({ ...subscribe, ...patch }).success).toBe(false);
    }
  });

  it("permits only bounded safe error/access-loss codes, never reflected private fields", () => {
    expect(contracts.roomServerMessageSchema).toBeDefined();
    const schema = contracts.roomServerMessageSchema;
    for (const message of [
      { protocol: 1, type: "error", code: "INVALID_MESSAGE" },
      { protocol: 1, type: "error", code: "UNAVAILABLE" },
      { protocol: 1, type: "access_lost" },
    ]) {
      expect(schema.safeParse(message).success).toBe(true);
      expect(schema.safeParse({ ...message, cookie: "secret" }).success).toBe(false);
      expect(schema.safeParse({ ...message, message: "untrusted reflection" }).success).toBe(false);
    }
    expect(schema.safeParse({ protocol: 2, type: "access_lost" }).success).toBe(false);
    expect(schema.safeParse({ protocol: 1, type: "update", room: {} }).success).toBe(false);
  });
});
