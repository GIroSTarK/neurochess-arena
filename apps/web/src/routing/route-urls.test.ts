import { describe, expect, it } from "vitest";

import { authHref, gameHref, parseGameId, safeReturnTo, withReturnTo } from "./route-urls";

const id = "abcdef00-1234-4000-8000-000000000001";

describe("canonical route URLs prepared for the Data router", () => {
  it("allows token-free room auth returns without carrying invitation inputs", () => {
    expect(safeReturnTo("/rooms")).toBe("/rooms");
    expect(safeReturnTo("/rooms/join")).toBe("/rooms/join");
    expect(authHref("sign-in", "/rooms/join")).toBe("/auth/sign-in?returnTo=%2Frooms%2Fjoin");
    expect(safeReturnTo("/rooms/join#invite=secret")).toBe("/");
    expect(safeReturnTo("/rooms/join?invite=secret")).toBe("/");
  });
  it("normalizes UUIDs and emits private game paths without a trailing slash", () => {
    expect(parseGameId(id.toUpperCase())).toBe(id);
    expect(gameHref("arena", id.toUpperCase())).toBe("/games/" + id);
    expect(gameHref("sandbox", id)).toBe("/sandbox/games/" + id);
  });

  it.each([undefined, null, "", "invalid", id + "/", "%2f" + id, "../" + id, [id]])(
    "rejects invalid game identity %j before construction",
    (value) => {
      expect(parseGameId(value)).toBeNull();
      if (typeof value === "string") expect(() => gameHref("arena", value)).toThrow();
    },
  );

  it("allows only public entry, history, and validated public game return paths", () => {
    expect(safeReturnTo("/history")).toBe("/history");
    expect(safeReturnTo("/games/" + id.toUpperCase())).toBe("/games/" + id);
    expect(authHref("sign-in", "/games/" + id)).toBe(
      "/auth/sign-in?returnTo=%2Fgames%2Fabcdef00-1234-4000-8000-000000000001",
    );
  });

  it("preserves return destinations for account links and every auth form action", () => {
    expect(withReturnTo("/account", "/")).toBe("/account");
    expect(withReturnTo("/account/credentials", "/history")).toBe(
      "/account/credentials?returnTo=%2Fhistory",
    );
    expect(withReturnTo("/auth/reset-password", "/games/" + id.toUpperCase())).toBe(
      "/auth/reset-password?returnTo=%2Fgames%2Fabcdef00-1234-4000-8000-000000000001",
    );
  });

  it.each([
    null,
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/account",
    "/sandbox",
    "/sandbox/games/" + id,
    "/?game=" + id,
    "/?game=",
    "/history/",
    "/history?next=/",
    "/Games/" + id,
    "/games/",
    "/games/bad",
    "/games/" + id + "/",
    "/games/" + id + "/extra",
    "/games/" + id + "?game=" + id,
    "/games/" + id + "#token=secret",
    "/games/%2f" + id,
    "/games/" + id + "%2f",
  ])("rejects unsupported or unsafe return paths %s", (value) => {
    expect(safeReturnTo(value)).toBe("/");
    expect(authHref("sign-up", value ?? "/")).toBe("/auth/sign-up");
    expect(withReturnTo("/account", value ?? "/")).toBe("/account");
  });
});
