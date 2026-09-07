import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { catalogResponse } from "../../../../test/ai-models";
import type { AiSetupApi } from "../api/ai";
import { snapshot } from "../test/fixtures";

import { useAiSeat } from "./useAiSeat";

function mockApi(): AiSetupApi {
  return {
    providers: vi.fn().mockResolvedValue([]),
    discover: vi.fn().mockResolvedValue(catalogResponse()),
    create: vi.fn().mockResolvedValue(snapshot()),
    unfinished: vi.fn().mockResolvedValue(null),
    game: vi.fn(),
  };
}

afterEach(() => vi.useRealTimers());

describe("seat catalog freshness", () => {
  it("clears setup keys on page exit and cannot restore them from late discovery", async () => {
    const response = Promise.withResolvers<Awaited<ReturnType<AiSetupApi["discover"]>>>();
    const discover = vi.fn<AiSetupApi["discover"]>().mockReturnValueOnce(response.promise);
    const api = { ...mockApi(), discover };
    const { result } = renderHook(() => useAiSeat(api));
    act(() => result.current.changeProvider("openai"));
    act(() => result.current.changeKey("page-only-fixture-key"));
    act(() => {
      void result.current.discover();
    });
    fireEvent(window, new PageTransitionEvent("pagehide", { persisted: true }));
    expect(result.current.key).toBe("");
    expect(discover.mock.calls[0]?.[1].aborted).toBe(true);
    await act(async () => response.resolve(catalogResponse()));
    expect(result.current.discovery.status).toBe("idle");
    expect(result.current.ready).toBe(false);
  });
  it.each(["controls", "key", "discovery", "expiry"] as const)(
    "discards native bad-input flags when %s resets the controls, preserving other values",
    async (reset) => {
      vi.useFakeTimers();
      const api = mockApi();
      const { result } = renderHook(() => useAiSeat(api));
      act(() => result.current.changeProvider("openai"));
      act(() => result.current.changeKey("fixture-key"));
      await act(() => result.current.discover());
      act(() => result.current.changeModel("fixture-full"));
      act(() => result.current.changeParameter("temperature", "0.5"));
      act(() => result.current.changeParameter("maxOutputTokens", "", true));
      expect(result.current.ready).toBe(false);
      if (reset === "controls") {
        act(() => result.current.resetNumericValidity());
        expect(result.current.ready).toBe(true);
      }
      if (reset === "key") act(() => result.current.changeKey("fixture-replacement"));
      if (reset === "expiry") {
        act(() => {
          vi.advanceTimersByTime(5 * 60_000);
        });
      }
      await act(() => result.current.discover());
      expect(result.current.ready).toBe(true);
      expect(result.current.configuration?.parameters).toEqual({ temperature: 0.5 });
      expect(result.current.draft.maxOutputTokens).toBe("");
      act(() => result.current.changeParameter("maxOutputTokens", "2048"));
      act(() => result.current.resetNumericValidity());
      expect(result.current.ready).toBe(false);
      await act(() => result.current.discover());
      expect(result.current.draft.maxOutputTokens).toBe("2048");
      expect(result.current.ready).toBe(false);
    },
  );

  it("passes the exact catalog reference for creation and refresh, separate from persistable configuration", async () => {
    const api = mockApi();
    const first = catalogResponse();
    const next = catalogResponse();
    const discover = vi
      .spyOn(api, "discover")
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ ok: false, error: { kind: "provider_auth" } })
      .mockResolvedValueOnce(next);
    const { result } = renderHook(() => useAiSeat(api));
    act(() => result.current.changeProvider("openai"));
    act(() => result.current.changeKey("fixture-key"));
    await act(() => result.current.discover());
    act(() => result.current.changeModel("fixture-full"));
    expect(result.current.selection).toEqual({
      ...result.current.configuration,
      catalogId: first.catalogId,
    });
    expect(result.current.configuration).not.toHaveProperty("catalogId");
    expect(result.current.configuration).not.toHaveProperty("apiKey");
    act(() => result.current.changeKey("fixture-next-key"));
    expect(result.current.selection).toBeNull();
    await act(() => result.current.discover());
    expect(discover.mock.calls[1]?.[2]).toBe(first.catalogId);
    expect(result.current.ready).toBe(false);
    await act(() => result.current.discover());
    expect(discover.mock.calls[2]?.[2]).toBeUndefined();
    expect(result.current.selection?.catalogId).toBe(next.catalogId);
    act(() => result.current.resetDiscovery());
    expect(result.current.selection).toBeNull();
    expect(result.current.key).toBe("fixture-next-key");
    await act(() => result.current.discover());
    expect(discover.mock.calls[3]?.[2]).toBeUndefined();
  });
  it("invalidates expired capabilities, including when a suspended tab has not run its timer", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const { result } = renderHook(() => useAiSeat(mockApi()));
    act(() => result.current.changeProvider("openai"));
    act(() => result.current.changeKey("fixture-key"));
    await act(() => result.current.discover());
    act(() => result.current.changeModel("fixture-full"));
    expect(result.current.ready).toBe(true);
    vi.setSystemTime(now + 5 * 60_000);
    act(() => {
      expect(result.current.ensureFresh()).toBe(false);
    });
    expect(result.current.ready).toBe(false);
    expect(result.current.key).toBe("fixture-key");
    expect(result.current.draft.modelId).toBe("fixture-full");
    await act(() => result.current.discover());
    expect(result.current.ready).toBe(true);
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(result.current.discovery.status).toBe("idle");
  });

  it("cancels an old provider's discovery and never accepts its late catalog", async () => {
    const api = mockApi();
    let finish: (value: Awaited<ReturnType<AiSetupApi["discover"]>>) => void = () => undefined;
    const discovery = vi.spyOn(api, "discover").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result, unmount } = renderHook(() => useAiSeat(api));
    act(() => result.current.changeProvider("openai"));
    act(() => result.current.changeKey("fixture-key"));
    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.discover();
    });
    const signal = discovery.mock.calls[0]?.[1];
    act(() => result.current.changeProvider("anthropic"));
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      finish(catalogResponse());
      await pending;
    });
    expect(result.current.discovery.status).toBe("idle");
    expect(result.current.draft.provider).toBe("anthropic");
    expect(result.current.key).toBe("");
    act(() => result.current.changeKey("fixture-next-key"));
    act(() => {
      pending = result.current.discover();
    });
    const nextSignal = discovery.mock.calls[1]?.[1];
    unmount();
    expect(nextSignal?.aborted).toBe(true);
    await act(async () => {
      finish(catalogResponse("anthropic"));
      await pending;
    });
  });
});
