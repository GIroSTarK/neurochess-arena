import { describe, expect, it } from "vitest";

import { authSessionResponseSchema, authSignOutRequestSchema } from "./auth.js";

describe("account transport boundary", () => {
  it("accepts absent sessions and the minimal safe account projection", () => {
    expect(authSessionResponseSchema.parse({ session: null })).toEqual({ session: null });
    expect(
      authSessionResponseSchema.safeParse({
        session: {
          user: { id: "account-id", email: "user@example.test", emailVerified: true },
          expiresAt: "2026-09-25T00:00:00.000Z",
        },
      }).success,
    ).toBe(true);
  });

  it("rejects credentials, library metadata, and unvalidated identity fields", () => {
    const session = {
      user: { id: "account-id", email: "user@example.test", emailVerified: true },
      expiresAt: "2026-09-25T00:00:00.000Z",
    };
    for (const extra of [
      { token: "secret" },
      { ipAddress: "127.0.0.1" },
      { sessionId: "private" },
    ]) {
      expect(
        authSessionResponseSchema.safeParse({ session: { ...session, ...extra } }).success,
      ).toBe(false);
    }
    for (const body of [
      { userId: "forged" },
      { callbackURL: "https://untrusted.test" },
      { token: "secret" },
    ]) {
      expect(authSignOutRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});
