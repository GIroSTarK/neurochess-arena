import { describe, expect, it, vi } from "vitest";

import { GAME_ID, jsonResponse, requestBody, requestPath } from "../test/fixtures";
import { INVITATION, roomSession, waitingRoom } from "../test/rooms";

import { createRoomApi } from "./room-client";

const signal = () => new AbortController().signal;
const identity = () => ({
  intent: "account" as const,
  expectedAccount: roomSession.user.id,
  signal: signal(),
  verify: async () => undefined,
});

describe("room HTTP client", () => {
  it("sends invitation secrets only in validated POST bodies with cookie authority", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ status: "joinable" }));
    const api = createRoomApi("https://api.example.test", { fetch, identity: identity() });
    await expect(api.resolve(INVITATION, signal())).resolves.toEqual({ status: "joinable" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(requestPath(url)).toBe("/rooms/invitations/resolve");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(JSON.parse(requestBody(init))).toEqual({ invitation: INVITATION });
    expect(new Headers(init?.headers).get("x-neurochess-expected-account")).toBe(
      roomSession.user.id,
    );
    await expect(api.resolve("unsafe", signal())).rejects.toMatchObject({ kind: "malformed" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("validates creation and issued secrets without retaining response diagnostics", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ room: waitingRoom("black"), invitation: INVITATION }));
    const api = createRoomApi("https://api.example.test", { fetch, identity: identity() });
    await expect(
      api.create({ operationId: GAME_ID, ownerColor: "black" }, signal()),
    ).resolves.toMatchObject({ room: { ownerColor: "black" } });
    expect(JSON.parse(requestBody(fetch.mock.calls[0]?.[1]))).toEqual({
      operationId: GAME_ID,
      ownerColor: "black",
    });
    fetch.mockResolvedValue(jsonResponse({ room: waitingRoom(), invitation: "unsafe" }));
    await expect(
      api.create({ operationId: GAME_ID, ownerColor: "black" }, signal()),
    ).rejects.toMatchObject({ kind: "malformed" });
    fetch.mockResolvedValue(
      jsonResponse(
        { code: "ROOM_UNAVAILABLE", message: INVITATION, requestId: "private-canary" },
        409,
      ),
    );
    const error = await api
      .join({ invitation: INVITATION, commandId: GAME_ID }, signal())
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "ROOM_UNAVAILABLE" });
    expect(JSON.stringify(error)).not.toMatch(/private-canary|AAAAAAAAAA/);
  });

  it("fences replies after identity loss and rejects private work without an identity", async () => {
    const response = Promise.withResolvers<Response>();
    const lifetime = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(() => response.promise);
    const api = createRoomApi("https://api.example.test", {
      fetch,
      identity: { ...identity(), signal: lifetime.signal },
    });
    const command = { invitation: INVITATION, commandId: GAME_ID };
    const join = api.join(command, signal());
    lifetime.abort();
    response.resolve(jsonResponse(waitingRoom()));
    await expect(join).rejects.toMatchObject({ kind: "cancelled" });
    await expect(
      createRoomApi("https://api.example.test", { fetch }).join(command, signal()),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
