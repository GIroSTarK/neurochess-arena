import { describe, expect, it, vi } from "vitest";

import { type CredentialApi, CredentialFailure } from "./client";
import { CredentialController } from "./controller";

const metadata = {
  credentialId: "11111111-1111-4111-8111-111111111111",
  provider: "openai" as const,
  label: "Saved",
  maskedSuffix: "test",
  createdAt: "2026-09-26T00:00:00.000Z",
};
function fixture() {
  const api = {
    list: vi
      .fn<CredentialApi["list"]>()
      .mockResolvedValue({ credentials: [metadata], nextCursor: null }),
    save: vi.fn<CredentialApi["save"]>().mockResolvedValue(metadata),
    revoke: vi.fn<CredentialApi["revoke"]>().mockResolvedValue({ success: true }),
    clear: vi.fn<CredentialApi["clear"]>().mockResolvedValue({ success: true }),
  };
  const owner = new AbortController();
  const expired = vi.fn();
  const controller = new CredentialController(api, owner.signal, expired);
  return { api, owner, expired, controller };
}
describe("account credential library", () => {
  it.each(["revoke", "clear", "more"] as const)(
    "keeps uncertain-save protection through %s until a successful first-page refresh",
    async (action) => {
      const { api, controller } = fixture();
      api.list.mockResolvedValueOnce({
        credentials: [metadata],
        nextCursor: metadata.credentialId,
      });
      await controller.refresh();
      const input = { save: true, provider: "openai", label: "Saved", apiKey: "raw-key" };
      api.save.mockRejectedValueOnce(new CredentialFailure("NETWORK"));
      await controller.save(input);
      if (action === "more") await controller.more();
      else if (action === "clear") {
        api.clear.mockRejectedValueOnce(new CredentialFailure("NETWORK"));
        await controller.clear();
      } else {
        api.revoke.mockRejectedValueOnce(new CredentialFailure("NETWORK"));
        await controller.revoke(metadata.credentialId);
      }
      expect(controller.getSnapshot().uncertain).toBe(true);
      await controller.save(input);
      expect(api.save).toHaveBeenCalledTimes(1);
      await controller.refresh();
      expect(controller.getSnapshot().uncertain).toBe(false);
      await controller.save(input);
      expect(api.save).toHaveBeenCalledTimes(2);
    },
  );
  it("loads paginated metadata without selecting keys and clears private state on owner cancellation", async () => {
    const { api, owner, controller } = fixture();
    api.list.mockResolvedValueOnce({ credentials: [metadata], nextCursor: metadata.credentialId });
    await controller.refresh();
    expect(controller.getSnapshot().credentials).toEqual([metadata]);
    await controller.more();
    expect(api.list).toHaveBeenLastCalledWith(metadata.credentialId, expect.any(AbortSignal));
    owner.abort();
    expect(controller.getSnapshot().credentials).toEqual([]);
  });

  it("never retries uncertain saves and requires a fresh list before another explicit save", async () => {
    const { api, controller } = fixture();
    const input = { save: true, provider: "openai", label: "Saved", apiKey: "raw-key" };
    api.save.mockRejectedValueOnce(new CredentialFailure("NETWORK"));
    await controller.save(input);
    expect(controller.getSnapshot()).toMatchObject({ uncertain: true, issue: "SAVE_UNCERTAIN" });
    await controller.save(input);
    expect(api.save).toHaveBeenCalledTimes(1);
    await controller.refresh();
    await controller.save(input);
    expect(api.save).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("raw-key");
  });

  it("removes only confirmed records and fences a late list after account switching", async () => {
    const { api, owner, controller } = fixture();
    await controller.refresh();
    api.revoke.mockRejectedValueOnce(new CredentialFailure("CREDENTIAL_UNAVAILABLE"));
    await controller.revoke(metadata.credentialId);
    expect(controller.getSnapshot().credentials).toEqual([metadata]);
    await controller.revoke(metadata.credentialId);
    expect(controller.getSnapshot().credentials).toEqual([]);
    let resolve!: (value: Awaited<ReturnType<CredentialApi["list"]>>) => void;
    api.list.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = controller.refresh();
    owner.abort();
    resolve({ credentials: [metadata], nextCursor: null });
    await pending;
    expect(controller.getSnapshot().credentials).toEqual([]);
  });
});
