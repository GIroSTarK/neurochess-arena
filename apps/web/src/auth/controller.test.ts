import type { AuthSessionResponse, ProfileResponse } from "@neurochess/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountFailure, type AuthApi } from "../api/auth-client";

import { AccountController } from "./controller";

const session = (id = "00000000-0000-4000-8000-000000000001"): AuthSessionResponse => ({
  user: { id, email: "private@example.com", emailVerified: true },
  session: { expiresAt: "2027-10-01T00:00:00.000Z" },
});
const profile: ProfileResponse = {
  username: "Player",
  completed: true,
  avatar: { source: "initials", initials: "PL" },
};
function fixture() {
  const api = {
    session: vi.fn(async () => session()),
    profile: vi.fn(async () => profile),
    signOut: vi.fn(async () => ({ success: true as const })),
  } as unknown as AuthApi;
  const controller = new AccountController(api);
  return { api, controller };
}
afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("page account identity", () => {
  it("refreshes onboarding, usernames and avatars for the same session without ending its game lifetime", async () => {
    const { api, controller } = fixture();
    vi.mocked(api.profile).mockResolvedValueOnce({
      username: null,
      completed: false,
      avatar: { source: "initials", initials: "?" },
    });
    await controller.refresh();
    const identity = controller.identity();
    const revision = controller.getSnapshot().revision;
    const updated: ProfileResponse = {
      ...profile,
      username: "Renamed",
      avatar: {
        source: "github",
        initials: "RE",
        url: "https://avatars.githubusercontent.com/u/123",
      },
    };
    vi.mocked(api.profile).mockResolvedValue(updated);
    await controller.refresh();
    expect(controller.getSnapshot().profile).toEqual(updated);
    expect(controller.getSnapshot().revision).toBe(revision);
    expect(identity.signal.aborted).toBe(false);
    await expect(identity.verify()).resolves.toBeUndefined();
    vi.mocked(api.profile).mockResolvedValue(profile);
    await controller.refresh();
    expect(controller.getSnapshot().profile?.avatar.source).toBe("initials");
  });
  it.each(["switch", "expiry"])(
    "immediately reconciles %s during the session-to-profile read",
    async (change) => {
      const { api, controller } = fixture();
      const replacement =
        change === "switch" ? session("00000000-0000-4000-8000-000000000002") : null;
      vi.mocked(api.profile).mockImplementationOnce(async () => {
        vi.mocked(api.session).mockResolvedValue(replacement);
        throw new AccountFailure("PROFILE_UNAUTHORIZED");
      });
      await controller.refresh();
      expect(controller.getSnapshot()).toMatchObject({
        phase: replacement ? "account" : "required",
        session: replacement,
        profile: replacement ? profile : null,
      });
    },
  );
  it("bounds reconciliation when profile authorization keeps failing", async () => {
    const { api, controller } = fixture();
    vi.mocked(api.profile).mockRejectedValue(new AccountFailure("PROFILE_UNAUTHORIZED"));
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "required",
      session: null,
      profile: null,
    });
    expect(vi.mocked(api.profile).mock.calls.length).toBeLessThanOrEqual(3);
  });
  it("binds sign-out to the displayed account before the transition clears it", async () => {
    const { api, controller } = fixture();
    await controller.refresh();
    vi.mocked(api.session).mockResolvedValue(session("00000000-0000-4000-8000-000000000002"));
    await controller.signOut();
    expect(api.signOut).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      "00000000-0000-4000-8000-000000000001",
    );
  });
  it("immediately clears private profile state when a save loses authorization after preflight", async () => {
    const { api, controller } = fixture();
    await controller.refresh();
    const identity = controller.identity();
    api.saveProfile = vi.fn(async () => {
      vi.mocked(api.session).mockResolvedValue(null);
      throw new AccountFailure("PROFILE_UNAUTHORIZED");
    });
    await expect(controller.saveProfile({ username: "NewName" })).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(identity.signal.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "required",
      profile: null,
      session: null,
    });
  });
  it("clears private data and aborts the old lifetime on expiry without guest fallback", async () => {
    const { api, controller } = fixture();
    await controller.refresh();
    expect(controller.getSnapshot().phase).toBe("account");
    const identity = controller.identity();
    vi.mocked(api.session).mockResolvedValue(null);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 15_001);
    await expect(identity.verify()).rejects.toMatchObject({ kind: "cancelled" });
    expect(identity.signal.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "required",
      session: null,
      profile: null,
    });
    const reloaded = new AccountController(api);
    await reloaded.refresh();
    expect(reloaded.getSnapshot().phase).toBe("required");
    await reloaded.chooseGuest();
    expect(reloaded.getSnapshot().phase).toBe("guest");
    expect(sessionStorage.length).toBe(0);
  });
  it("fences a delayed old profile when an identity transition starts", async () => {
    const { api, controller } = fixture();
    const pending = Promise.withResolvers<ProfileResponse>();
    vi.mocked(api.profile).mockReturnValueOnce(pending.promise);
    const first = controller.refresh();
    await vi.waitFor(() => expect(api.profile).toHaveBeenCalledOnce());
    const signIn = controller.transition(async () => {
      vi.mocked(api.session).mockResolvedValue(session("00000000-0000-4000-8000-000000000002"));
      vi.mocked(api.profile).mockResolvedValue({ ...profile, username: "NewPlayer" });
    });
    await signIn;
    pending.resolve(profile);
    await first;
    expect(controller.getSnapshot().profile?.username).toBe("NewPlayer");
  });
  it("invalidates even another session for the same account and requires onboarding equally", async () => {
    const { api, controller } = fixture();
    await controller.refresh();
    const identity = controller.identity();
    vi.mocked(api.session).mockResolvedValue({
      ...session()!,
      session: { expiresAt: "2027-10-02T00:00:00.000Z" },
    });
    vi.mocked(api.profile).mockResolvedValue({
      username: null,
      completed: false,
      avatar: { source: "initials", initials: "?" },
    });
    await controller.refresh();
    expect(identity.signal.aborted).toBe(true);
    expect(controller.getSnapshot().profile?.completed).toBe(false);
    await expect(controller.identity().verify()).rejects.toMatchObject({ kind: "cancelled" });
  });
  it("clears identity immediately on sign-out even when its acknowledgement is delayed", async () => {
    const { api, controller } = fixture();
    await controller.refresh();
    const identity = controller.identity();
    const pending = Promise.withResolvers<{ success: true }>();
    vi.mocked(api.signOut).mockReturnValue(pending.promise);
    const logout = controller.signOut();
    expect(identity.signal.aborted).toBe(true);
    expect(controller.getSnapshot().profile).toBeNull();
    vi.mocked(api.session).mockResolvedValue(null);
    pending.resolve({ success: true });
    await logout;
    expect(controller.getSnapshot().phase).toBe("required");
  });
});
