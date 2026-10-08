import type { CredentialMetadata } from "@neurochess/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GAME_ID, OTHER_GAME_ID } from "../test/fixtures";
import { cleanupMatches, matchDetails, matchHarness } from "../test/match-session";

const saved: CredentialMetadata = {
  credentialId: GAME_ID,
  provider: "openai",
  label: "Saved key",
  maskedSuffix: "1234",
  createdAt: "2026-10-08T00:00:00.000Z",
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanupMatches();
  vi.useRealTimers();
});

describe("SeatCredentials", () => {
  it("requires a compatible explicit saved selection and invalidates it when revoked", async () => {
    const h = matchHarness(matchDetails("white"));
    await h.enter();
    h.seats.setCredential("black", OTHER_GAME_ID, [
      { ...saved, credentialId: OTHER_GAME_ID, provider: "anthropic" },
    ]);
    expect(h.store.get().keys.black).toBe(false);
    h.seats.setCredential("black", GAME_ID, [saved]);
    expect(h.store.get()).toMatchObject({
      keys: { white: false, black: true },
      selections: { white: "session", black: GAME_ID },
    });
    expect(h.seats.current?.require("black", "openai")).toEqual({ credentialId: GAME_ID });
    const epoch = h.store.get().keyEpoch;
    h.seats.reconcile([]);
    expect(h.store.get()).toMatchObject({
      keys: { black: false },
      selections: { black: "session" },
      keyEpoch: epoch + 1,
    });
    expect(() => h.seats.current?.require("black", "openai")).toThrow();
    expect(h.api.turn).not.toHaveBeenCalled();
  });

  it("publishes readiness without raw secrets and blocks key changes during commands", async () => {
    const h = matchHarness(matchDetails("white"));
    await h.enter();
    h.seats.setKey("white", "human-secret-sentinel");
    h.seats.setKey("black", "ai-secret-sentinel");
    expect(h.store.get().keys).toEqual({ white: false, black: true });
    expect(JSON.stringify(h.store.get())).not.toContain("secret-sentinel");
    h.store.setActivity({ ...h.store.getActivity(), busy: true });
    h.seats.setKey("black", "replacement-secret");
    h.seats.setCredential("black", GAME_ID, [saved]);
    expect(h.seats.current?.require("black", "openai")).toEqual({ apiKey: "ai-secret-sentinel" });
    h.store.setActivity({ ...h.store.getActivity(), busy: false });
    h.seats.setKey("black", "");
    expect(h.store.get().keys.black).toBe(false);
  });

  it("disposes old credentials and re-enters without restoring a selection", async () => {
    const h = matchHarness(matchDetails("white"));
    await h.enter();
    h.seats.setCredential("black", GAME_ID, [saved]);
    const previous = h.seats.current!;
    await h.enter();
    expect(() => previous.require("black", "openai")).toThrow();
    expect(() => previous.set("black", "openai", "obsolete-secret")).toThrow();
    expect(h.store.get()).toMatchObject({
      keys: { black: false },
      selections: { black: "session" },
    });
  });
});
