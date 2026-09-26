import { describe, expect, it, vi } from "vitest";

import { createSessionCredentials } from "./session-credentials";

describe("page-memory credentials", () => {
  it("replaces raw keys with saved references independently and clears both on pagehide", () => {
    const owner = new AbortController();
    const keys = createSessionCredentials(owner.signal);
    const credentialId = "11111111-1111-4111-8111-111111111111";
    try {
      keys.set("white", "openai", "discarded-raw-key");
      keys.setSaved("white", "openai", credentialId);
      keys.set("black", "google", "black-key");
      expect(keys.require("white", "openai")).toEqual({ credentialId });
      expect(keys.require("black", "google")).toEqual({ apiKey: "black-key" });
      expect(() => keys.require("white", "google")).toThrow("AI_KEY_REQUIRED");
      expect(() => keys.setSaved("white", "openai", "invalid")).toThrow();
      expect(JSON.stringify(keys)).not.toContain(credentialId);
      window.dispatchEvent(new Event("pagehide"));
      expect(() => keys.require("white", "openai")).toThrow("AI_KEY_REQUIRED");
      expect(() => keys.require("black", "google")).toThrow("AI_KEY_REQUIRED");
    } finally {
      owner.abort();
    }
  });
  it("isolates seats and providers and never writes browser persistence or serializable state", () => {
    const persist = vi.spyOn(Storage.prototype, "setItem");
    const lifetime = new AbortController();
    const keys = createSessionCredentials(lifetime.signal);
    try {
      keys.set("white", "openai", "white-sentinel");
      keys.set("black", "openai", "black-sentinel");
      expect(keys.require("white", "openai")).toEqual({ apiKey: "white-sentinel" });
      expect(keys.require("black", "openai")).toEqual({ apiKey: "black-sentinel" });
      expect(() => keys.require("white", "anthropic")).toThrow("AI_KEY_REQUIRED");
      expect(JSON.stringify(keys)).not.toContain("sentinel");
      keys.set("white", "google", "replacement-sentinel");
      expect(() => keys.require("white", "openai")).toThrow("AI_KEY_REQUIRED");
      expect(keys.require("white", "google")).toEqual({ apiKey: "replacement-sentinel" });
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
