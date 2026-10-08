import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { jsonResponse } from "../test/fixtures";

import { createHttpRequest, type HttpFailureKind } from "./http";

class TestFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const errors = {
  schema: z.object({ code: z.literal("DENIED") }),
  failure: (kind: HttpFailureKind) => new TestFailure(kind),
  isFailure: (error: unknown): error is TestFailure => error instanceof TestFailure,
  fromResponse: (error: { code: "DENIED" }, context: string | undefined) =>
    new TestFailure(context ? `${error.code}:${context}` : error.code),
};
const schema = z.object({ status: z.literal("ready") });
const signal = () => new AbortController().signal;

afterEach(() => vi.useRealTimers());

describe("shared HTTP transport", () => {
  it("validates responses and sends private JSON requests with per-request headers", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ status: "ready" }));
    const request = createHttpRequest({
      baseUrl: "https://api.example.test",
      fetch,
      errors,
      headers: { "x-neurochess-identity": "account" },
    });
    await expect(
      request(
        "/example",
        schema,
        signal(),
        { confirm: true },
        {
          expectedAccount: "account-id",
        },
      ),
    ).resolves.toEqual({ status: "ready" });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(new URL("https://api.example.test/example"), {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        accept: "application/json",
        "x-neurochess-identity": "account",
        "x-neurochess-expected-account": "account-id",
        "content-type": "application/json",
      },
      body: '{"confirm":true}',
      signal: expect.any(AbortSignal) as unknown,
    });
  });

  it.each([
    { name: "invalid JSON", response: () => new Response("private-canary"), code: "malformed" },
    {
      name: "invalid success",
      response: () => jsonResponse({ status: "private-canary" }),
      code: "malformed",
    },
    {
      name: "unknown error",
      response: () => jsonResponse({ code: "private-canary" }, 400),
      code: "malformed",
    },
    {
      name: "safe error",
      response: () => jsonResponse({ code: "DENIED", message: "private-canary" }, 403),
      code: "DENIED:resource",
    },
  ])("maps $name without retaining response prose", async ({ response, code }) => {
    const request = createHttpRequest({
      baseUrl: "https://api.example.test",
      fetch: vi.fn().mockResolvedValue(response()),
      errors,
    });
    const error: unknown = await request("/example", schema, signal(), undefined, {
      errorContext: "resource",
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(TestFailure);
    expect(error).toMatchObject({ code, message: code });
    expect(JSON.stringify(error)).not.toContain("private-canary");
  });

  it("maps network errors without retaining exceptions or retrying", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("private-canary"));
    const request = createHttpRequest({ baseUrl: "https://api.example.test", fetch, errors });
    await expect(request("/example", schema, signal())).rejects.toMatchObject({
      code: "network",
      message: "network",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("accepts a declared status without bypassing response validation", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ status: "ready" }, 503));
    const request = createHttpRequest({ baseUrl: "https://api.example.test", fetch, errors });
    await expect(
      request("/ready", schema, signal(), undefined, { acceptStatus: 503 }),
    ).resolves.toEqual({ status: "ready" });
    fetch.mockResolvedValue(jsonResponse({ status: "private-canary" }, 503));
    await expect(
      request("/ready", schema, signal(), undefined, { acceptStatus: 503 }),
    ).rejects.toMatchObject({ code: "malformed" });
  });

  it.each(["request", "owner"] as const)(
    "fences late responses after %s cancellation and cleans up",
    async (cancelled) => {
      vi.useFakeTimers();
      const pending = Promise.withResolvers<Response>();
      const caller = new AbortController();
      const owner = new AbortController();
      const removeCaller = vi.spyOn(caller.signal, "removeEventListener");
      const removeOwner = vi.spyOn(owner.signal, "removeEventListener");
      const fetch = vi.fn<typeof globalThis.fetch>(() => pending.promise);
      const request = createHttpRequest({
        baseUrl: "https://api.example.test",
        fetch,
        errors,
        signal: owner.signal,
      });
      const result = request("/example", schema, caller.signal);
      (cancelled === "request" ? caller : owner).abort("private-canary");
      pending.resolve(jsonResponse({ status: "ready" }));
      await expect(result).rejects.toMatchObject({ code: "cancelled" });
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(removeCaller).toHaveBeenCalledOnce();
      expect(removeOwner).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      await expect(request("/example", schema, caller.signal)).rejects.toMatchObject({
        code: "cancelled",
      });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("distinguishes timeout from owner cancellation when both occur", async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<Response>();
    const caller = new AbortController();
    const request = createHttpRequest({
      baseUrl: "https://api.example.test",
      fetch: vi.fn(() => pending.promise),
      errors,
      timeoutMs: 25,
    });
    const result = request("/example", schema, caller.signal);
    await vi.advanceTimersByTimeAsync(25);
    caller.abort();
    pending.reject(new Error("private-canary"));
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    "preserves preparation timing with timeoutAfterPreparation=%s",
    async (timeoutAfterPreparation) => {
      vi.useFakeTimers();
      const preparation = Promise.withResolvers<void>();
      const fetch = vi.fn<typeof globalThis.fetch>(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            if (init?.signal?.aborted) reject(new Error("private-canary"));
            init?.signal?.addEventListener("abort", () => reject(new Error("private-canary")), {
              once: true,
            });
          }),
      );
      const request = createHttpRequest({
        baseUrl: "https://api.example.test",
        fetch,
        errors,
        beforeRequest: () => preparation.promise,
        timeoutAfterPreparation,
      });
      const result = expect(
        request("/example", schema, signal(), undefined, { timeoutMs: 25 }),
      ).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(25);
      expect(fetch).not.toHaveBeenCalled();
      preparation.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(!timeoutAfterPreparation);
      if (timeoutAfterPreparation) await vi.advanceTimersByTimeAsync(25);
      await result;
      expect(fetch).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("fences identity loss during successful response verification", async () => {
    const owner = new AbortController();
    const verification = Promise.withResolvers<void>();
    const afterResponse = vi.fn(() => verification.promise);
    const request = createHttpRequest({
      baseUrl: "https://api.example.test",
      fetch: vi.fn().mockResolvedValue(jsonResponse({ status: "ready" })),
      errors,
      signal: owner.signal,
      afterResponse,
    });
    const result = request("/example", schema, signal());
    await vi.waitFor(() => expect(afterResponse).toHaveBeenCalledOnce());
    owner.abort();
    verification.resolve();
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
  });

  it("preserves a completed transport while successful identity verification finishes", async () => {
    vi.useFakeTimers();
    const verification = Promise.withResolvers<void>();
    const afterResponse = vi.fn(() => verification.promise);
    const request = createHttpRequest({
      baseUrl: "https://api.example.test",
      fetch: vi.fn().mockResolvedValue(jsonResponse({ status: "ready" })),
      errors,
      timeoutMs: 25,
      afterResponse,
    });
    const result = request("/example", schema, signal());
    await vi.advanceTimersByTimeAsync(0);
    expect(afterResponse).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(25);
    verification.resolve();
    await expect(result).resolves.toEqual({ status: "ready" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
