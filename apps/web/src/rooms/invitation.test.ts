import { afterEach, describe, expect, it } from "vitest";

import { INVITATION } from "../test/rooms";

import { consumeRoomInvitation, parseInvitation } from "./invitation";

afterEach(() => window.history.replaceState(null, "", "/"));

describe("room invitation entry", () => {
  it("scrubs later fragment arrivals before router history listeners while preserving their entry index", () => {
    window.history.replaceState(null, "", "/rooms/join");
    const invitation = consumeRoomInvitation();
    const routerHashes: string[] = [];
    const observe = () => routerHashes.push(window.location.hash);
    window.addEventListener("popstate", observe);
    try {
      window.history.replaceState(
        { idx: 2, key: "entry", usr: null },
        "",
        `/rooms/join#invite=${INVITATION}`,
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
      expect(routerHashes).toEqual([""]);
      expect(invitation.read()).toBe(INVITATION);
      expect(window.history.state).toEqual({ idx: 2, key: "entry", usr: null });
      invitation.retire();
      expect(invitation.read()).toBeNull();
    } finally {
      window.removeEventListener("popstate", observe);
      invitation.dispose();
    }
  });
  it("scrubs the fragment before routing and retires the memory value on pagehide", () => {
    window.history.replaceState({ unsafe: true }, "", `/rooms/join#invite=${INVITATION}`);
    const invitation = consumeRoomInvitation();
    expect(window.location.hash).toBe("");
    expect(window.history.state).toBeNull();
    expect(invitation.read()).toBe(INVITATION);
    window.dispatchEvent(new Event("pagehide"));
    expect(invitation.read()).toBeNull();
    invitation.dispose();
  });

  it.each(["/auth/sign-in", "/account", "/rooms", "/rooms/join?returnTo=/"])(
    "never adopts a token from %s",
    (path) => {
      window.history.replaceState(null, "", `${path}#invite=${INVITATION}`);
      const invitation = consumeRoomInvitation();
      expect(window.location.hash).toBe("");
      expect(invitation.read()).toBeNull();
      invitation.dispose();
    },
  );

  it("accepts a code or exact same-origin link and rejects URL/query smuggling", () => {
    const origin = "https://arena.example";
    expect(parseInvitation(` ${INVITATION} `, origin)).toBe(INVITATION);
    expect(parseInvitation(`${origin}/rooms/join#invite=${INVITATION}`, origin)).toBe(INVITATION);
    for (const input of [
      `${origin}/rooms/join?invite=${INVITATION}`,
      `${origin}/rooms/join#invite=${INVITATION}&invite=${INVITATION}`,
      `https://other.example/rooms/join#invite=${INVITATION}`,
      `${origin}/auth/sign-in#invite=${INVITATION}`,
      `${origin}/rooms/join#invite=${INVITATION}&extra=true`,
    ]) {
      expect(parseInvitation(input, origin)).toBeNull();
    }
  });
});
