import { describe, expect, it, vi } from "vitest";

import { GAME_ID, jsonResponse, requestBody } from "../test/fixtures";

import type { AiIdentity } from "./ai-client";
import { createCredentialApi } from "./credential-client";

const signal = () => new AbortController().signal;
const identity = (): AiIdentity => ({
  intent: "account",
  expectedAccount: GAME_ID,
  signal: signal(),
  verify: async () => undefined,
});
const metadata = {
  credentialId: GAME_ID,
  provider: "openai",
  label: "Arena",
  maskedSuffix: "1234",
  createdAt: "2026-10-01T00:00:00.000Z",
};

describe("credential HTTP boundary", () => {
  it.each([
    { credentials: [{ ...metadata, apiKey: "private-canary" }] },
    { credentials: [{ ...metadata, ciphertext: "private-canary" }] },
    { credentials: [{ ...metadata, provider: "private-canary" }] },
  ])(
    "rejects secret-bearing or malformed metadata without exposing validation details",
    async (payload) => {
      const api = createCredentialApi(
        "https://api.example.test",
        identity(),
        vi.fn().mockResolvedValue(jsonResponse(payload)),
      );
      const error: unknown = await api.list(signal()).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
      expect(JSON.stringify(error)).not.toContain("private-canary");
      expect(String(error)).not.toContain("private-canary");
    },
  );
  it("uses the expected account, scoped deletion bodies and no automatic mutation retry", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => jsonResponse({ status: "deleted" }));
    const api = createCredentialApi("https://api.example.test", identity(), fetch);
    await api.revoke(GAME_ID, signal());
    await api.clear(signal());
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(requestBody(init)) as unknown)).toEqual([
      { credentialId: GAME_ID },
      { confirm: true },
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init?.headers).get("x-neurochess-expected-account")).toBe(GAME_ID);
      expect(init).toMatchObject({
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
    }
    fetch.mockRejectedValue(new Error("private-canary"));
    await expect(api.clear(signal())).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("blocks guests before dispatch and discards a late old-account list", async () => {
    const pending = Promise.withResolvers<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>(() => pending.promise);
    await expect(
      createCredentialApi(
        "https://api.example.test",
        { ...identity(), intent: "guest" },
        fetch,
      ).list(signal()),
    ).rejects.toMatchObject({ code: "CREDENTIAL_UNAUTHORIZED" });
    expect(fetch).not.toHaveBeenCalled();
    const owner = new AbortController();
    const api = createCredentialApi(
      "https://api.example.test",
      { ...identity(), signal: owner.signal },
      fetch,
    );
    const result = api.list(signal());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    owner.abort();
    pending.resolve(jsonResponse({ credentials: [metadata] }));
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
  });
  it("invalidates identity on unauthorized metadata and discards server prose", async () => {
    const lost = vi.fn();
    const api = createCredentialApi(
      "https://api.example.test",
      { ...identity(), lost },
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { code: "CREDENTIAL_UNAUTHORIZED", message: "private-canary", requestId: "test" },
            401,
          ),
        ),
    );
    const error: unknown = await api.list(signal()).catch((error: unknown) => error);
    expect(lost).toHaveBeenCalledOnce();
    expect(String(error)).not.toContain("private-canary");
  });
});
