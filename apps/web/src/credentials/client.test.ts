import { describe, expect, it, vi } from "vitest";

import { createCredentialApi } from "./client";

const credentialId = "11111111-1111-4111-8111-111111111111";
export const metadata = {
  credentialId,
  provider: "openai" as const,
  label: "My provider",
  maskedSuffix: "test",
  createdAt: "2026-09-26T00:00:00.000Z",
};

describe("credential management transport", () => {
  it("validates explicit consent and accepts only safe metadata with no plaintext readback", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(metadata)));
    const api = createCredentialApi("https://api.example.test", fetcher);
    const signal = new AbortController().signal;
    await expect(
      api.save({ save: false, provider: "openai", label: "My provider", apiKey: "secret" }, signal),
    ).rejects.toMatchObject({ code: "CREDENTIAL_INVALID_REQUEST" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await api.save(
        { save: true, provider: "openai", label: "My provider", apiKey: "secret" },
        signal,
      ),
    ).toEqual(metadata);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      credentials: "include",
      cache: "no-store",
      redirect: "error",
    });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...metadata, apiKey: "secret" })));
    const failure = await api
      .save({ save: true, provider: "openai", label: "My provider", apiKey: "secret" }, signal)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    expect(String(failure)).not.toContain("secret");
  });

  it("fences replies after identity cancellation even when fetch ignores abort", async () => {
    const lifetime = new AbortController();
    const api = createCredentialApi("https://api.example.test", async () => {
      lifetime.abort();
      return new Response(JSON.stringify({ credentials: [metadata], nextCursor: null }));
    });
    await expect(api.list(null, lifetime.signal)).rejects.toMatchObject({ code: "NETWORK" });
  });
});
