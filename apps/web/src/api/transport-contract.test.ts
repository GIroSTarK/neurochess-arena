import { afterEach, describe, expect, it, vi } from "vitest";

import { GAME_ID, jsonResponse } from "../test/fixtures";

import { createAiApi } from "./ai-client";
import { AccountFailure, createAuthApi } from "./auth-client";
import { createCredentialApi, CredentialFailure } from "./credential-client";
import { ApiFailure } from "./failures";
import { createPublicGameApi } from "./public-game-client";
import { createSandboxApi } from "./sandbox-client";

const origin = "https://api.example.test";
const clients = [
  {
    name: "Sandbox",
    request: (fetch: typeof globalThis.fetch, signal: AbortSignal) =>
      createSandboxApi(origin, { fetch }).ready(signal),
    unavailable: { kind: "network" },
    malformed: { kind: "malformed" },
    timeout: { kind: "timeout" },
    cancelled: { kind: "cancelled" },
    failure: ApiFailure,
  },
  {
    name: "AI",
    request: (fetch: typeof globalThis.fetch, signal: AbortSignal) =>
      createAiApi(origin, { fetch }).invocations(GAME_ID, signal),
    unavailable: { kind: "network" },
    malformed: { kind: "malformed" },
    timeout: { kind: "timeout" },
    cancelled: { kind: "cancelled" },
    failure: ApiFailure,
  },
  {
    name: "public game",
    request: (fetch: typeof globalThis.fetch, signal: AbortSignal) =>
      createPublicGameApi(origin, { fetch }).unfinished(signal),
    unavailable: { kind: "network" },
    malformed: { kind: "malformed" },
    timeout: { kind: "timeout" },
    cancelled: { kind: "cancelled" },
    failure: ApiFailure,
  },
  {
    name: "account",
    request: (fetch: typeof globalThis.fetch, signal: AbortSignal) =>
      createAuthApi(origin, { fetch }).session(signal),
    unavailable: { code: "AUTH_UNAVAILABLE" },
    malformed: { code: "AUTH_UNAVAILABLE" },
    timeout: { code: "AUTH_UNAVAILABLE" },
    cancelled: { code: "cancelled" },
    failure: AccountFailure,
  },
  {
    name: "credential",
    request: (fetch: typeof globalThis.fetch, signal: AbortSignal) =>
      createCredentialApi(
        origin,
        {
          intent: "account",
          expectedAccount: GAME_ID,
          signal: new AbortController().signal,
          verify: async () => undefined,
        },
        fetch,
      ).list(signal),
    unavailable: { code: "CREDENTIAL_UNAVAILABLE" },
    malformed: { code: "CREDENTIAL_UNAVAILABLE" },
    timeout: { code: "CREDENTIAL_UNAVAILABLE" },
    cancelled: { code: "cancelled" },
    failure: CredentialFailure,
  },
];

afterEach(() => vi.useRealTimers());

describe.each(clients)("$name transport error contract", (client) => {
  it.each([
    {
      name: "network exception",
      fetch: () => vi.fn().mockRejectedValue(new Error("private-canary")),
      kind: "unavailable" as const,
    },
    {
      name: "broken JSON",
      fetch: () => vi.fn().mockResolvedValue(new Response("private-canary")),
      kind: "malformed" as const,
    },
    {
      name: "unknown server code",
      fetch: () =>
        vi
          .fn()
          .mockResolvedValue(
            jsonResponse({ code: "private-canary", message: "private-canary" }, 500),
          ),
      kind: "malformed" as const,
    },
    {
      name: "invalid response",
      fetch: () => vi.fn().mockResolvedValue(jsonResponse({ secret: "private-canary" })),
      kind: "malformed" as const,
    },
  ])("retains its safe failure type for $name", async ({ fetch: createFetch, kind }) => {
    const fetch = createFetch();
    const error: unknown = await client
      .request(fetch, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(client.failure);
    expect(error).toMatchObject(client[kind]);
    expect(String(error)).not.toContain("private-canary");
    expect(JSON.stringify(error)).not.toContain("private-canary");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps the ten-second default deadline and does not retry", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("private-canary")), {
            once: true,
          });
        }),
    );
    const pending = expect(
      client.request(fetch, new AbortController().signal),
    ).rejects.toMatchObject(client.timeout);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps caller cancellation distinct from transport failure", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("private-canary")), {
            once: true,
          });
        }),
    );
    const caller = new AbortController();
    const result = client.request(fetch, caller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    caller.abort("private-canary");
    await expect(result).rejects.toMatchObject(client.cancelled);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
