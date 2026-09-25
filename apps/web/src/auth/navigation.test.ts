import { describe, expect, it } from "vitest";

import { consumeAuthEntry, safeReturn } from "./navigation";

describe("account navigation", () => {
  it("consumes callback fragments and removes unrelated query data before rendering", () => {
    window.history.replaceState(
      null,
      "",
      "/auth/reset-password?token=do-not-retain#token=test-token",
    );
    expect(consumeAuthEntry()).toEqual({ token: "test-token" });
    expect(window.location.href).not.toMatch(/token|#/);
    expect(consumeAuthEntry()).toEqual({});
  });
  it.each([
    "//evil.test",
    "/\\evil.test",
    "https://evil.test/",
    "/auth/sign-in",
    "/?game=no",
    "/?game=04306f87-f39e-4ad3-87c0-f7e69d2cfbda&token=secret",
    "/#token=x",
  ])("rejects unsafe return %s", (value) => expect(safeReturn(value)).toBe("/"));
  it("accepts only a private UUID game or Arena", () => {
    expect(safeReturn("/?game=04306f87-f39e-4ad3-87c0-f7e69d2cfbda")).toBe(
      "/?game=04306f87-f39e-4ad3-87c0-f7e69d2cfbda",
    );
    window.history.replaceState(null, "", "/auth/complete#error=provider-secret&code=secret");
    expect(consumeAuthEntry()).toEqual({ error: "AUTH_OAUTH_FAILED" });
    expect(window.location.hash).toBe("");
  });
});
