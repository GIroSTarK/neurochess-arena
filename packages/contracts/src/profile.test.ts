import { describe, expect, it } from "vitest";

import {
  profileOnboardingRequestSchema,
  profileResponseSchema,
  profileUpdateRequestSchema,
  profileUsernameSchema,
  safeProviderAvatar,
} from "./profile.js";

describe("profile transport boundaries", () => {
  it("trims usernames, preserves display case, and accepts the inclusive length bounds", () => {
    expect(profileUsernameSchema.parse("  Ab_  ")).toBe("Ab_");
    expect(profileUsernameSchema.parse("X".repeat(24))).toBe("X".repeat(24));
  });
  it.each([
    "ab",
    "x".repeat(25),
    "first last",
    "hello-world",
    "first.last",
    "éclair",
    "玩家名字",
    "email@example.com",
    "<b>name</b>",
    "player\u200b",
    "ADMIN",
    "Administrator",
    "api",
    "arena",
    "auth",
    "guest",
    "help",
    "login",
    "logout",
    "moderator",
    "neurochess",
    "root",
    "security",
    "support",
    "system",
    "www",
  ])("rejects invalid or reserved username %j", (username) => {
    expect(profileUsernameSchema.safeParse(username).success).toBe(false);
  });
  it.each([
    {},
    { username: null },
    { username: "Valid", userId: "other" },
    { username: "Valid", email: "private@example.com" },
    { avatar: "https://avatars.githubusercontent.com/u/1" },
    { avatar: { source: "google", url: "https://lh3.googleusercontent.com/a" } },
    { avatar: "restore" },
  ])("rejects unwanted update input %j", (input) => {
    expect(profileUpdateRequestSchema.safeParse(input).success).toBe(false);
  });
  it("requires a username for onboarding and permits avatar removal independently afterward", () => {
    expect(profileOnboardingRequestSchema.safeParse({ avatar: "remove" }).success).toBe(false);
    expect(profileUpdateRequestSchema.parse({ avatar: "remove" })).toEqual({ avatar: "remove" });
  });
  it.each([
    "http://avatars.githubusercontent.com/u/1",
    "https://evil.example/avatar",
    "https://avatars.githubusercontent.com.evil.example/u/1",
    "https://evil-avatars.githubusercontent.com/u/1",
    "https://evil.example@avatars.githubusercontent.com/u/1",
    "https://avatars.githubusercontent.com:444/u/1",
    "https://avatars.githubusercontent.com/u/1#secret",
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/>",
    "https://127.0.0.1/avatar",
    "https://avatars.githubusercontent.com\\@evil.example/a",
    "https://avatars.git\nhubusercontent.com/u/1",
    " https://avatars.githubusercontent.com/u/1",
    "https://avatars.githubusercontent.com/u/" + "x".repeat(2048),
    null,
    {},
  ])("drops unsafe provider avatar %j", (url) => {
    expect(safeProviderAvatar("github", url)).toBeNull();
  });
  it("binds each avatar host to its provider and validates output without exposing email", () => {
    expect(safeProviderAvatar("google", "https://lh3.googleusercontent.com/a/photo")).toBe(
      "https://lh3.googleusercontent.com/a/photo",
    );
    expect(safeProviderAvatar("github", "https://avatars.githubusercontent.com/u/1?v=4")).toBe(
      "https://avatars.githubusercontent.com/u/1?v=4",
    );
    expect(safeProviderAvatar("google", "https://avatars.githubusercontent.com/u/1")).toBeNull();
    expect(safeProviderAvatar("github", "https://lh3.googleusercontent.com/a/photo")).toBeNull();
    expect(
      profileResponseSchema.safeParse({
        username: null,
        completed: true,
        avatar: { source: "initials", initials: "?" },
      }).success,
    ).toBe(false);
    expect(
      profileResponseSchema.safeParse({
        username: "Valid",
        completed: true,
        avatar: { source: "github", initials: "VA", url: "https://evil.example/a" },
      }).success,
    ).toBe(false);
    expect(
      profileResponseSchema.safeParse({
        username: "Valid",
        completed: true,
        email: "private@example.com",
        avatar: { source: "initials", initials: "VA" },
      }).success,
    ).toBe(false);
  });
});
