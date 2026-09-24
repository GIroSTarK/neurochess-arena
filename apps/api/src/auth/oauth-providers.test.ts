import { describe, expect, it } from "vitest";

import { safeOAuthAvatar } from "./oauth-providers.js";

describe("provider avatar admission", () => {
  it("accepts supported HTTPS image hosts and drops arbitrary URLs without fetching them", () => {
    expect(safeOAuthAvatar("google", "https://lh3.googleusercontent.com/a/avatar=s96")).toBe(
      "https://lh3.googleusercontent.com/a/avatar=s96",
    );
    expect(safeOAuthAvatar("github", "https://avatars.githubusercontent.com/u/123?v=4")).toBe(
      "https://avatars.githubusercontent.com/u/123?v=4",
    );
    for (const value of [
      null,
      {},
      "javascript:alert(1)",
      "https://attacker.test/image",
      "https://avatars.githubusercontent.com.attacker.test/u/1",
      "https://private@avatars.githubusercontent.com/u/1",
      "http://avatars.githubusercontent.com/u/1",
      "https://avatars.githubusercontent.com:444/u/1",
      "https://avatars.githubusercontent.com/u/1#token",
      "x".repeat(2049),
    ]) {
      expect(safeOAuthAvatar("github", value)).toBeUndefined();
    }
    expect(
      safeOAuthAvatar("google", "https://avatars.githubusercontent.com/u/123"),
    ).toBeUndefined();
  });
});
