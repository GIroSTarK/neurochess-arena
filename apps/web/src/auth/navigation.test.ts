import { describe, expect, it } from "vitest";

import { safeReturnTo } from "../app/route-urls";

import { consumeAuthEntry } from "./navigation";

describe("account navigation", () => {
  it.each(["/history", "/games/00000000-0000-4000-8000-000000000001"])(
    "keeps a credentials return destination across document reloads: %s",
    (returnTo) => {
      window.history.replaceState(
        null,
        "",
        "/account/credentials?returnTo=" +
          encodeURIComponent(returnTo) +
          "&state=private-canary#token=secret-canary",
      );
      expect(consumeAuthEntry().returnTo).toBe(returnTo);
      expect(consumeAuthEntry().returnTo).toBe(returnTo);
      expect(window.location.href).not.toMatch(/canary|token|state=/);
    },
  );
  it.each([
    "/history?utm_source=fixture",
    "/sandbox",
    "/games/00000000-0000-4000-8000-000000000001",
  ])("removes a token fragment outside auth without consuming it: %s", (path) => {
    window.history.replaceState(null, "", path + "#token=secret-canary&extra=ignored");
    const entry = consumeAuthEntry();
    expect(entry.hasResetToken).toBe(false);
    expect(window.location.pathname + window.location.search).toBe(path);
    expect(window.location.hash).toBe("");
  });
  it("keeps non-token fragments outside auth", () => {
    window.history.replaceState(null, "", "/history#account-main");
    consumeAuthEntry();
    expect(window.location.hash).toBe("#account-main");
  });
  it.each([
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/sandbox",
    "/?game=bad",
    "/?game=00000000-0000-4000-8000-000000000001&token=secret",
    "/#token=secret",
  ])("rejects unsafe return destination %s", (value) => {
    expect(safeReturnTo(value)).toBe("/");
  });
  it("keeps only a valid private Arena game destination", () => {
    expect(safeReturnTo("/games/00000000-0000-4000-8000-000000000001")).toBe(
      "/games/00000000-0000-4000-8000-000000000001",
    );
  });
  it("rejects an otherwise valid legacy return target", () => {
    expect(safeReturnTo("/?game=00000000-0000-4000-8000-000000000001")).toBe("/");
  });
  it("recognizes a directly opened canonical game as the auth return destination", () => {
    window.history.replaceState(null, "", "/games/00000000-0000-4000-8000-000000000001");
    expect(consumeAuthEntry().returnTo).toBe("/games/00000000-0000-4000-8000-000000000001");
  });
  it("consumes reset fragments and callback queries without leaving tokens in history", () => {
    window.history.replaceState(
      null,
      "",
      "/auth/reset-password?returnTo=https://evil.test#token=reset-canary",
    );
    const entry = consumeAuthEntry();
    expect(entry.readResetToken()).toBe("reset-canary");
    expect(entry.returnTo).toBe("/");
    expect(window.location.href).not.toMatch(/token|canary|evil/);
    window.history.replaceState(
      null,
      "",
      "/?auth=oauth-error&code=AUTH_OAUTH_ACCOUNT_CONFLICT&state=secret",
    );
    expect(consumeAuthEntry().error).toBe("AUTH_OAUTH_ACCOUNT_CONFLICT");
    expect(window.location.search).toBe("");
  });
  it("keeps an obsolete game target invalid when scrubbing callback fields", () => {
    window.history.replaceState(null, "", "/?game=&auth=email-verified&state=callback-canary");
    consumeAuthEntry();
    expect(new URLSearchParams(window.location.search).has("game")).toBe(true);
    expect(window.location.href).not.toContain("callback-canary");
  });
});
