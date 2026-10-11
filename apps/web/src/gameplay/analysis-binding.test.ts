import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiFailure } from "../api/failures";
import { snapshot } from "../test/fixtures";

import { AnalysisBinding } from "./analysis-binding";

afterEach(() => vi.restoreAllMocks());

describe("analysis view binding", () => {
  it("clears synchronously on game removal, identity abort and pagehide", () => {
    for (const trigger of ["source", "identity", "pagehide"] as const) {
      const signal = new AbortController();
      let position: ReturnType<typeof snapshot> | null = snapshot();
      let notify: () => void = () => undefined;
      const binding = new AnalysisBinding(
        {
          getSnapshot: () => position,
          subscribe: (listener) => {
            notify = listener;
            return () => undefined;
          },
        },
        (value) => (value ? { snapshot: value, ply: 0 } : null),
        {
          signal: signal.signal,
          authorize: () => Promise.resolve(),
        },
      );
      const end = binding.connect();
      expect(binding.getSnapshot().plies).toHaveLength(1);
      if (trigger === "source") {
        position = null;
        notify();
      } else if (trigger === "identity") signal.abort();
      else window.dispatchEvent(new Event("pagehide"));
      expect(binding.getSnapshot().plies).toEqual([]);
      position = snapshot();
      notify();
      if (trigger !== "source") expect(binding.getSnapshot().plies).toEqual([]);
      end();
    }
  });

  it("does not load private samples after failed visibility authorization", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const read = vi.fn();
    const binding = new AnalysisBinding(
      { getSnapshot: () => snapshot(), subscribe: () => () => undefined },
      (value) => ({ snapshot: value, ply: 0 }),
      {
        api: { read, write: vi.fn() },
        authorize: async () => {
          throw new ApiFailure("api", "NOT_FOUND");
        },
      },
    );
    const end = binding.connect();
    expect(binding.getSnapshot().plies[0]?.status).toBe("suspended");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(binding.getSnapshot().plies).toEqual([]));
    expect(read).not.toHaveBeenCalled();
    end();
  });
});
