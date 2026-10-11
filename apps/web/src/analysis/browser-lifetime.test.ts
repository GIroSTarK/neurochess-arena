import { describe, expect, it, vi } from "vitest";

import { bindAnalysisLifetime } from "./browser-lifetime";

describe("analysis browser lifetime", () => {
  it("suspends immediately while hidden, reauthorizes on return, and disposes on pagehide", () => {
    const scheduler = { suspend: vi.fn(), resume: vi.fn(), dispose: vi.fn() };
    const reauthorize = vi.fn(async () => true);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const signal = new AbortController();
    const cleanup = bindAnalysisLifetime(scheduler, { signal: signal.signal, reauthorize });
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(scheduler.suspend).toHaveBeenCalledOnce();
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(scheduler.resume).toHaveBeenCalledWith(reauthorize);
    window.dispatchEvent(new Event("pagehide"));
    expect(scheduler.dispose).toHaveBeenCalledOnce();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(scheduler.resume).toHaveBeenCalledTimes(1);
    cleanup();
    visibility.mockRestore();
  });

  it("uses the adapter lifetime signal for identity/access/deletion/navigation and supports unmount", () => {
    for (const end of ["abort", "unmount", "already-aborted"] as const) {
      const scheduler = { suspend: vi.fn(), resume: vi.fn(), dispose: vi.fn() };
      const controller = new AbortController();
      if (end === "already-aborted") controller.abort();
      const cleanup = bindAnalysisLifetime(scheduler, {
        signal: controller.signal,
        reauthorize: async () => true,
      });
      if (end === "abort") controller.abort();
      cleanup();
      expect(scheduler.dispose).toHaveBeenCalledOnce();
    }
  });
});
