import type { ProfileResponse } from "@neurochess/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAccountApi } from "./client";
import { AccountController } from "./controller";

const profile: ProfileResponse = {
  username: "Alice",
  onboardingRequired: false,
  avatar: { source: "initials", initials: "AL" },
  providerAvatar: null,
};
const session = (id: string) => ({
  user: { id, email: id + "@example.test", emailVerified: true },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
function setup() {
  const api = createAccountApi("http://localhost:3001", vi.fn());
  vi.spyOn(api, "session").mockResolvedValue({ session: null });
  vi.spyOn(api, "profile").mockResolvedValue(profile);
  vi.spyOn(api, "signOut").mockResolvedValue({ success: true });
  const controller = new AccountController(api);
  const close = controller.connect();
  cleanup.push(close);
  return { api, controller };
}
const cleanup: (() => void)[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup.splice(0).forEach((close) => close());
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("account identity lifetime", () => {
  it("does not read an old session while a sign-in mutation is in progress", async () => {
    const { api, controller } = setup();
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("ready"));
    controller.beginChange();
    const scope = controller.signal;
    const reads = vi.mocked(api.session).mock.calls.length;
    await controller.check();
    expect(api.session).toHaveBeenCalledTimes(reads);
    expect(scope.aborted).toBe(false);
    vi.mocked(api.session).mockResolvedValue({ session: session("new-account") });
    await controller.changed();
    expect(controller.getSnapshot().session?.user.id).toBe("new-account");
    expect(scope.aborted).toBe(true);
  });
  it("keeps anonymous reads passive and requires explicit guest action after account loss", async () => {
    const { api, controller } = setup();
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("ready"));
    vi.mocked(api.session).mockResolvedValue({ session: session("alice") });
    await controller.check();
    const old = controller.signal;
    expect(controller.getSnapshot().profile).toEqual(profile);
    vi.mocked(api.session).mockResolvedValue({ session: null });
    await controller.check();
    expect(old.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "ended",
      session: null,
      profile: null,
    });
    await controller.check();
    expect(controller.getSnapshot().phase).toBe("ended");
    await controller.signOut(true);
    expect(controller.getSnapshot().phase).toBe("ready");
    expect(api.signOut).toHaveBeenCalledOnce();
    expect(localStorage.getItem("neurochess.account-context")).toBe("guest");
  });
  it("fences a delayed old-account profile while another tab changes identity", async () => {
    const { api, controller } = setup();
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("ready"));
    const delayed = Promise.withResolvers<ProfileResponse>();
    vi.mocked(api.session).mockResolvedValue({ session: session("alice") });
    vi.mocked(api.profile).mockReturnValueOnce(delayed.promise);
    const pending = controller.check();
    await vi.waitFor(() => expect(api.profile).toHaveBeenCalledOnce());
    const old = controller.signal;
    vi.mocked(api.session).mockResolvedValue({ session: session("bob") });
    vi.mocked(api.profile).mockResolvedValue({ ...profile, username: "Bob" });
    window.dispatchEvent(
      new StorageEvent("storage", { key: "neurochess.identity-change", newValue: "changed" }),
    );
    await vi.waitFor(() => expect(controller.getSnapshot().profile?.username).toBe("Bob"));
    delayed.resolve(profile);
    await pending;
    expect(old.aborted).toBe(true);
    expect(controller.getSnapshot().session?.user.id).toBe("bob");
    expect(controller.getSnapshot().profile?.username).toBe("Bob");
    expect(JSON.stringify(Object.values(localStorage))).not.toContain("Alice");
  });
  it("clears private state before a failed sign-out and keeps a retry path", async () => {
    const { api, controller } = setup();
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("ready"));
    vi.mocked(api.session).mockResolvedValue({ session: session("alice") });
    await controller.check();
    vi.mocked(api.signOut).mockRejectedValueOnce(new Error("private error"));
    const old = controller.signal;
    await controller.signOut();
    expect(old.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "error",
      session: null,
      profile: null,
      issue: "NETWORK",
    });
    await controller.signOut();
    expect(controller.getSnapshot().phase).toBe("ended");
  });
});
