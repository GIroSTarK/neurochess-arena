import { describe, expect, it, vi } from "vitest";

import { jsonResponse } from "../test/fixtures";

import { createAuthApi } from "./auth-client";

describe("account transport", () => {
  it("sends the observed account assertion on sign-out", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ success: true }));
    const api = createAuthApi("http://localhost:3001", { fetch });
    await api.signOut(new AbortController().signal, "00000000-0000-4000-8000-000000000001");
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-neurochess-expected-account"),
    ).toBe("00000000-0000-4000-8000-000000000001");
  });
  it("uses validated credentialed requests and never retains server error prose", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(
        { code: "AUTH_INVALID_CREDENTIALS", message: "secret-canary", requestId: "request" },
        401,
      ),
    );
    const api = createAuthApi("http://localhost:3001", { fetch });
    await expect(
      api.signIn(
        { email: "a@example.com", password: "test-password" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "AUTH_INVALID_CREDENTIALS",
      message: "AUTH_INVALID_CREDENTIALS",
    });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  });
  it("rejects unsafe provider redirects and malformed profile data", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ url: "https://evil.test/steal" }),
    );
    const api = createAuthApi("http://localhost:3001", { fetch });
    await expect(api.social("google", new AbortController().signal)).rejects.toMatchObject({
      code: "AUTH_UNAVAILABLE",
    });
    fetch.mockResolvedValue(
      jsonResponse({
        username: "User",
        completed: true,
        avatar: { source: "github", initials: "US", url: "https://evil.test/image" },
      }),
    );
    await expect(api.profile(new AbortController().signal)).rejects.toMatchObject({
      code: "AUTH_UNAVAILABLE",
    });
  });
  it("discards a response delivered after cancellation", async () => {
    const pending = Promise.withResolvers<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>(() => pending.promise);
    const api = createAuthApi("http://localhost:3001", { fetch });
    const abort = new AbortController();
    const read = api.session(abort.signal);
    abort.abort();
    pending.resolve(jsonResponse(null));
    await expect(read).rejects.toMatchObject({ code: "cancelled" });
  });
});
