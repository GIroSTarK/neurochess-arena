import { describe, expect, it, vi } from "vitest";

import { createSessionCredentials } from "./session-credentials";

describe("page-memory credentials", () => {
  it("isolates seats and providers and never writes browser persistence or serializable state", () => {
    const persist = vi.spyOn(Storage.prototype, "setItem");
    const lifetime = new AbortController();
    const keys = createSessionCredentials(lifetime.signal);
    try {
      keys.set("white", "openai", "white-sentinel");
      keys.set("black", "openai", "black-sentinel");
      expect(keys.require("white", "openai")).toBe("white-sentinel");
      expect(keys.require("black", "openai")).toBe("black-sentinel");
      expect(() => keys.require("white", "anthropic")).toThrow("AI_KEY_REQUIRED");
      expect(JSON.stringify(keys)).not.toContain("sentinel");
      keys.set("white", "google", "replacement-sentinel");
      expect(() => keys.require("white", "openai")).toThrow("AI_KEY_REQUIRED");
      expect(keys.require("white", "google")).toBe("replacement-sentinel");
      keys.remove("black");
      expect(() => keys.require("black", "openai")).toThrow("AI_KEY_REQUIRED");
      expect(persist).not.toHaveBeenCalled();
    } finally {
      keys.dispose();
      persist.mockRestore();
    }
  });

  it.each(["pagehide", "owner", "dispose"] as const)(
    "clears keys on %s and restores no credentials into a new page instance",
    (event) => {
      const owner = new AbortController();
      const keys = createSessionCredentials(owner.signal);
      keys.set("white", "openai", "page-key-sentinel");
      if (event === "pagehide") window.dispatchEvent(new Event("pagehide"));
      else if (event === "owner") owner.abort();
      else keys.dispose();
      expect(() => keys.require("white", "openai")).toThrow("AI_KEY_REQUIRED");
      const restored = createSessionCredentials(new AbortController().signal);
      expect(() => restored.require("white", "openai")).toThrow("AI_KEY_REQUIRED");
      if (event !== "pagehide") {
        expect(() => keys.set("white", "openai", "new-key")).toThrow("AI_KEY_REQUIRED");
      }
      keys.dispose();
      restored.dispose();
    },
  );
});
