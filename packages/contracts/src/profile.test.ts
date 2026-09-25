import { describe, expect, it } from "vitest";

import {
  profileOnboardingRequestSchema,
  profileResponseSchema,
  profileUpdateRequestSchema,
  reservedUsernames,
  safeProviderAvatar,
  usernameSchema,
} from "./profile.js";

describe("private profile contracts", () => {
  it("trims display casing without deriving or accepting identity fields", () => {
    expect(usernameSchema.parse("  Chess_Fan42  ")).toBe("Chess_Fan42");
    expect(usernameSchema.parse("A".repeat(24))).toHaveLength(24);
    expect(profileOnboardingRequestSchema.safeParse({ avatar: "initials" }).success).toBe(false);
    expect(profileUpdateRequestSchema.safeParse({ avatar: "initials" }).success).toBe(true);
    expect(profileUpdateRequestSchema.safeParse({}).success).toBe(false);
  });
  it.each([
    "ab",
    "a".repeat(25),
    "9Player",
    "_Player",
    "chess fan",
    "chess-fan",
    "Аlice",
    "İllya",
    "<b>me</b>",
    "A\nb",
    ...reservedUsernames.map((name) => name.toUpperCase()),
  ])("rejects invalid/reserved username %s", (username) => {
    expect(usernameSchema.safeParse(username).success).toBe(false);
  });
  it.each([
    "userId",
    "id",
    "email",
    "name",
    "image",
    "avatarUrl",
    "usernameNormalized",
    "onboardingRequired",
  ])("rejects caller-controlled %s", (field) => {
    expect(
      profileUpdateRequestSchema.safeParse({ username: "Player", [field]: "forged" }).success,
    ).toBe(false);
  });
  it.each([
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/>",
    "http://lh3.googleusercontent.com/a",
    "https://lh3.googleusercontent.com.evil.test/a",
    "https://evil.test/a",
    "https://localhost/a",
    "https://lh3.googleusercontent.com@evil.test/a",
    "https://user@lh3.googleusercontent.com/a",
    "https://lh3.googleusercontent.com:444/a",
    "https://lh3.googleusercontent.com/a#fragment",
    "https://lh3.googleusercontent.com/a\n",
    "https://lh3.googleusercontent.com/<img>",
    "https://lh3.googleusercontent.com/" + "a".repeat(2048),
    {},
    null,
  ])("rejects an unsafe avatar %j", (value) => {
    expect(safeProviderAvatar("google", value)).toBeUndefined();
  });
  it("validates provider-specific URLs and response completion consistency", () => {
    expect(safeProviderAvatar("github", "https://lh3.googleusercontent.com/a")).toBeUndefined();
    expect(safeProviderAvatar("github", "https://avatars.githubusercontent.com/u/123?v=4")).toBe(
      "https://avatars.githubusercontent.com/u/123?v=4",
    );
    const profile = {
      username: "Player",
      onboardingRequired: false,
      avatar: { source: "initials", initials: "PL" },
      providerAvatar: null,
    };
    expect(profileResponseSchema.safeParse(profile).success).toBe(true);
    expect(profileResponseSchema.safeParse({ ...profile, onboardingRequired: true }).success).toBe(
      false,
    );
    expect(
      profileResponseSchema.safeParse({
        ...profile,
        avatar: { source: "google", url: "https://evil.test/a", initials: "PL" },
      }).success,
    ).toBe(false);
    expect(
      profileResponseSchema.safeParse({ ...profile, email: "private@example.test" }).success,
    ).toBe(false);
  });
});
