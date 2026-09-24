import { describe, expect, it } from "vitest";

import {
  authEmailRequestSchema,
  authResetPasswordRequestSchema,
  authSessionResponseSchema,
  authSignOutRequestSchema,
  authSignUpRequestSchema,
  authVerifyEmailRequestSchema,
} from "./auth.js";

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

  it("normalizes email, preserves password text, and bounds lifecycle input", () => {
    const input = { email: "Player@Example.Test", password: "  a long passphrase  " };
    expect(authSignUpRequestSchema.parse(input)).toEqual({
      ...input,
      email: "player@example.test",
    });
    for (const password of ["short", "x".repeat(129)]) {
      expect(authSignUpRequestSchema.safeParse({ ...input, password }).success).toBe(false);
      expect(
        authResetPasswordRequestSchema.safeParse({ token: "opaque-token", newPassword: password })
          .success,
      ).toBe(false);
    }
    expect(authSignUpRequestSchema.safeParse({ ...input, password: "x".repeat(12) }).success).toBe(
      true,
    );
    expect(authSignUpRequestSchema.safeParse({ ...input, password: "x".repeat(128) }).success).toBe(
      true,
    );
    for (const email of [
      "bad-email",
      "a@example.test\r\nBcc: other@example.test",
      `${"a".repeat(254)}@example.test`,
    ]) {
      expect(authEmailRequestSchema.safeParse({ email }).success).toBe(false);
    }
    for (const token of ["", "a".repeat(2049), "token&callbackURL=//evil.test", "token\n"]) {
      expect(authVerifyEmailRequestSchema.safeParse({ token }).success).toBe(false);
    }
  });
});
