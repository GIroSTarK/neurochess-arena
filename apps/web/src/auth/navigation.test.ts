import { describe, expect, it } from "vitest";

import { consumeAuthEntry, safeReturn } from "./navigation";

describe("account navigation", () => {
  it.each(["/auth/complete", "/auth/complete#"])(
    "does not infer an OAuth failure from an empty completion URL: %s",
    (url) => {
      window.history.replaceState(null, "", url);
      expect(consumeAuthEntry()).toEqual({});
      expect(window.location.hash).toBe("");
    },
  );
  it.each([
    ["#status=signed-in", { result: "signed-in" }],
    ["#status=linked", { result: "linked" }],
    ["#error=AUTH_OAUTH_CONFLICT", { error: "AUTH_OAUTH_CONFLICT" }],
    ["#error=AUTH_REAUTHENTICATION_REQUIRED", { error: "AUTH_REAUTHENTICATION_REQUIRED" }],
    ["#error=AUTH_OAUTH_FAILED", { error: "AUTH_OAUTH_FAILED" }],
    ["#error=", { error: "AUTH_OAUTH_FAILED" }],
    ["#status=unknown", { error: "AUTH_OAUTH_FAILED" }],
  ] as const)("preserves non-empty OAuth completion handling for %s", (hash, expected) => {
    window.history.replaceState(null, "", "/auth/complete" + hash);
    expect(consumeAuthEntry()).toEqual(expected);
    expect(window.location.hash).toBe("");
  });
  it("does not turn an already consumed OAuth success into a failure", () => {
    window.history.replaceState(null, "", "/auth/complete#status=signed-in");
    expect(consumeAuthEntry()).toEqual({ result: "signed-in" });
    expect(consumeAuthEntry()).toEqual({});
  });
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
    "/history?token=secret",
    "/history#token=x",
  ])("rejects unsafe return %s", (value) => expect(safeReturn(value)).toBe("/"));
  it("accepts only a private UUID game, history or Arena", () => {
    expect(safeReturn("/history")).toBe("/history");
    expect(safeReturn("/?game=04306f87-f39e-4ad3-87c0-f7e69d2cfbda")).toBe(
      "/?game=04306f87-f39e-4ad3-87c0-f7e69d2cfbda",
    );
    window.history.replaceState(null, "", "/auth/complete#error=provider-secret&code=secret");
    expect(consumeAuthEntry()).toEqual({ error: "AUTH_OAUTH_FAILED" });
    expect(window.location.hash).toBe("");
  });
});
