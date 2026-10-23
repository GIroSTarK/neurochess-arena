import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  errorResponse,
  GAME_ID,
  jsonResponse,
  OTHER_GAME_ID,
  requestPath,
  snapshot,
} from "../test/fixtures";
import { createHttpMock } from "../test/http";
import { renderApp } from "../test/render";
import { INVITATION, joinedRoom, roomProfile, roomSession } from "../test/rooms";

const options = { apiBaseUrl: "http://localhost:3001", sandboxEnabled: false };
const roomConfiguration = {
  mode: "human_vs_human",
  seats: { white: { type: "human" }, black: { type: "human" } },
};
class Socket extends EventTarget {
  static instances: Socket[] = [];
  constructor() {
    super();
    Socket.instances.push(this);
  }
  close = vi.fn();
  send = vi.fn();
  frame(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}
afterEach(() => {
  Socket.instances = [];
  vi.unstubAllGlobals();
});

describe("public game feature selection", () => {
  it("adopts a guest join at the canonical URL without duplicate reads or AI recovery", async () => {
    const room = joinedRoom();
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      "POST /guest-session": () => jsonResponse({ status: "ready" }),
      "POST /rooms/join": () => jsonResponse(room),
    });
    vi.stubGlobal("fetch", http.fetch);
    vi.stubGlobal("WebSocket", Socket);
    const { router } = renderApp(options, { initialEntries: ["/rooms/join"], strict: true });
    await userEvent.type(
      await screen.findByRole("textbox", { name: "Invitation link or code" }),
      INVITATION,
    );
    await userEvent.click(screen.getByRole("button", { name: "Join as guest" }));
    await screen.findByRole("grid");
    expect(router.state.location.pathname).toBe(`/games/${GAME_ID}`);
    expect(JSON.stringify(router.state.loaderData)).not.toContain(INVITATION);
    expect(JSON.stringify(router.state.location.state)).not.toContain(INVITATION);
    expect(http.fetch.mock.calls.map(([url]) => requestPath(url))).not.toContain(
      `/games/${GAME_ID}/details`,
    );
    expect(http.fetch.mock.calls.map(([url]) => requestPath(url))).not.toContain(
      `/rooms/${GAME_ID}`,
    );
    http.assertNoUnexpectedRequests();
  });

  it("retires each mode on departure and applies recovery Pause only to the AI game", async () => {
    const room = joinedRoom();
    let ai = snapshot([], { gameId: OTHER_GAME_ID });
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      [`GET /games/${GAME_ID}/details`]: () =>
        jsonResponse({ snapshot: room.snapshot, configuration: roomConfiguration }),
      [`GET /rooms/${GAME_ID}`]: () => jsonResponse(room),
      [`GET /games/${OTHER_GAME_ID}/details`]: () =>
        jsonResponse({
          snapshot: ai,
          configuration: {
            mode: "ai_vs_human",
            seats: {
              white: { type: "human" },
              black: { type: "ai", provider: "openai", modelId: "fixture", parameters: {} },
            },
          },
        }),
      [`GET /games/${OTHER_GAME_ID}/invocations`]: () =>
        jsonResponse({ gameId: OTHER_GAME_ID, version: ai.version, turns: [] }),
      [`POST /games/${OTHER_GAME_ID}/lifecycle`]: () => {
        ai = snapshot([], {
          gameId: OTHER_GAME_ID,
          state: "paused",
          legalMoves: [],
          version: ai.version + 1,
        });
        return jsonResponse(ai);
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    vi.stubGlobal("WebSocket", Socket);
    const { router } = renderApp(options, { initialEntries: [`/games/${GAME_ID}`] });
    await screen.findByRole("grid");
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    const first = Socket.instances[0]!;
    act(() => first.frame({ protocol: 1, type: "snapshot", room }));
    await act(() => router.navigate(`/games/${OTHER_GAME_ID}`));
    await screen.findByRole("button", { name: "Resume" });
    expect(first.close).toHaveBeenCalledTimes(1);
    await act(() => router.revalidate());
    expect(
      http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("/lifecycle")),
    ).toHaveLength(1);
    await act(() => router.navigate(`/games/${GAME_ID}`));
    await waitFor(() => expect(Socket.instances).toHaveLength(2));
    act(() => Socket.instances[1]!.frame({ protocol: 1, type: "snapshot", room }));
    expect(await screen.findByRole("button", { name: "Resign" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    act(() =>
      first.frame({
        protocol: 1,
        type: "update",
        room: { ...room, snapshot: snapshot(["e2e4"], { version: 2 }) },
      }),
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("e4");
    http.assertNoUnexpectedRequests();
  });

  it("clears the room lifetime on identity change and rejects late reads and socket frames", async () => {
    const room = joinedRoom();
    let session = roomSession;
    let delayed = false;
    let readSignal: AbortSignal | null | undefined;
    const pending = Promise.withResolvers<Response>();
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse(roomProfile),
      [`GET /games/${GAME_ID}/details`]: (init) =>
        new Headers(init?.headers).get("x-neurochess-expected-account") === OTHER_GAME_ID
          ? errorResponse("NOT_FOUND", 404)
          : jsonResponse({ snapshot: room.snapshot, configuration: roomConfiguration }),
      [`GET /rooms/${GAME_ID}`]: (init) => {
        if (!delayed) return jsonResponse(room);
        readSignal = init?.signal;
        return pending.promise;
      },
      [`GET /games/${GAME_ID}/analysis?limit=128`]: () =>
        jsonResponse({ gameId: GAME_ID, samples: [], nextCursor: null }),
    });
    vi.stubGlobal("fetch", http.fetch);
    vi.stubGlobal("WebSocket", Socket);
    const { router } = renderApp(options, { initialEntries: [`/games/${GAME_ID}`] });
    await screen.findByRole("grid");
    await waitFor(() => expect(Socket.instances).toHaveLength(1));
    const socket = Socket.instances[0]!;
    act(() => socket.frame({ protocol: 1, type: "snapshot", room }));
    const issued: unknown = router.state.loaderData["arena-game"];
    delayed = true;
    let reading = Promise.resolve();
    await act(async () => {
      reading = router.revalidate();
    });
    await waitFor(() => expect(readSignal).toBeDefined());
    const channel = new BroadcastChannel("neurochess.identity");
    try {
      session = { ...roomSession, user: { ...roomSession.user, id: OTHER_GAME_ID } };
      await act(async () => channel.postMessage("changed"));
      await waitFor(() => expect(readSignal?.aborted).toBe(true));
      expect(issued).toMatchObject({ data: null });
      expect(socket.close).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("grid")).not.toBeInTheDocument();
      await act(async () => {
        pending.resolve(jsonResponse(room));
        await reading;
        socket.frame({ protocol: 1, type: "update", room });
      });
      await waitFor(() =>
        expect(router.state.loaderData["arena-game"]).toMatchObject({
          data: { entry: { kind: "unavailable", code: "access" } },
        }),
      );
      expect(screen.queryByRole("grid")).not.toBeInTheDocument();
      expect(Socket.instances).toHaveLength(1);
      http.assertNoUnexpectedRequests();
    } finally {
      channel.close();
    }
  });
});
