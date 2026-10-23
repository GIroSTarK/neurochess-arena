import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RouteObject } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  errorResponse,
  FOOLS_MATE,
  GAME_ID,
  jsonResponse,
  requestBody,
  requestPath,
  snapshot,
} from "../test/fixtures";
import { createHttpMock as createBaseHttpMock, type HttpRoutes } from "../test/http";
import { renderApp } from "../test/render";
import { INVITATION, joinedRoom, roomProfile, roomSession, waitingRoom } from "../test/rooms";

const configuration = {
  mode: "human_vs_human",
  seats: { white: { type: "human" }, black: { type: "human" } },
};
const options = { apiBaseUrl: "http://localhost:3001", sandboxEnabled: false };
const createHttpMock = (routes: HttpRoutes) =>
  createBaseHttpMock({
    [`GET /games/${GAME_ID}/analysis?limit=128`]: () =>
      jsonResponse({ gameId: GAME_ID, samples: [], nextCursor: null }),
    ...routes,
  });
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
  vi.restoreAllMocks();
});

describe("production private room routes", () => {
  it("keeps clipboard fallback selectable and requires a fresh owner decision after a conflict", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("unavailable"));
    const waiting = waitingRoom("black");
    const changed = { ...waiting, snapshot: { ...waiting.snapshot, version: 1 } };
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(roomSession),
      "GET /profile": () => jsonResponse(roomProfile),
      "GET /games/unfinished": () => jsonResponse({ game: null }),
      "POST /rooms/creation-operation": () =>
        jsonResponse({ operationId: GAME_ID, expiresAt: "2027-01-01T00:00:00.000Z" }),
      "POST /rooms": () => jsonResponse({ room: waiting, invitation: INVITATION }),
      [`POST /games/${GAME_ID}/lifecycle`]: () =>
        errorResponse("GAME_CONFLICT", 409, changed.snapshot),
    });
    vi.stubGlobal("fetch", http.fetch);
    vi.stubGlobal("WebSocket", Socket);
    renderApp(options, { initialEntries: ["/rooms"] });
    await user.click(await screen.findByRole("button", { name: "Create room" }));
    await screen.findByRole("textbox", { name: /^Invitation link$/ });
    await waitFor(() => expect(Socket.instances.length).toBe(1));
    act(() => Socket.instances[0]!.frame({ protocol: 1, type: "snapshot", room: waiting }));
    await user.click(screen.getByRole("button", { name: "Copy invitation" }));
    expect(await screen.findByText(/select and copy the invitation/i)).toBeVisible();
    const link = screen.getByRole("textbox", { name: "Invitation link" });
    expect(link).toHaveValue(`${window.location.origin}/rooms/join#invite=${INVITATION}`);
    await user.click(link);
    expect((link as HTMLTextAreaElement).selectionEnd).toBe(
      (link as HTMLTextAreaElement).value.length,
    );
    expect(screen.getByText("Waiting for White")).toBeVisible();
    expect(screen.queryByRole("button", { name: /resign|resume|pause/i })).not.toBeInTheDocument();
    const closures = () =>
      http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("/lifecycle"));
    for (const label of ["Revoke invitation", "Replace invitation", "Close room"]) {
      await user.click(screen.getByRole("button", { name: label }));
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
      await user.click(screen.getByRole("button", { name: "Cancel" }));
    }
    expect(closures()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Close room" }));
    await user.click(screen.getByRole("button", { name: "Confirm close" }));
    await waitFor(() => expect(Socket.instances.length).toBe(2));
    expect(JSON.parse(requestBody(closures()[0]![1]))).toMatchObject({
      action: "abort",
      gameId: GAME_ID,
      expectedVersion: 0,
    });
    act(() => Socket.instances[1]!.frame({ protocol: 1, type: "snapshot", room: changed }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(closures()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Close room" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(closures()).toHaveLength(1);
    http.assertNoUnexpectedRequests();
  });
  it("offers replacement on re-entry and retains a waiting room after invitation revocation", async () => {
    const waiting = { ...waitingRoom(), invitationAvailable: false };
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(roomSession),
      "GET /profile": () => jsonResponse(roomProfile),
      [`GET /games/${GAME_ID}/details`]: () =>
        jsonResponse({ snapshot: waiting.snapshot, configuration }),
      [`GET /rooms/${GAME_ID}`]: () => jsonResponse(waiting),
    });
    vi.stubGlobal("fetch", http.fetch);
    vi.stubGlobal("WebSocket", Socket);
    renderApp(options, { initialEntries: [`/games/${GAME_ID}`] });
    expect(await screen.findByRole("heading", { name: "Waiting for opponent" })).toBeVisible();
    expect(screen.getByText(/replace the invitation to share a new link/i)).toBeVisible();
    expect(screen.getByText(/your public game slot stays reserved/i)).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Invitation link" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace invitation" })).toBeVisible();
    http.assertNoUnexpectedRequests();
  });
  it("keeps explicit recovery retryable after a failed read, without replacing a healthy owner on revalidation", async () => {
    let unavailable = false;
    const joined = joinedRoom();
    const slow = Promise.withResolvers<null>();
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(roomSession),
      "GET /profile": () => jsonResponse(roomProfile),
      [`GET /games/${GAME_ID}/details`]: () =>
        jsonResponse({ snapshot: joined.snapshot, configuration }),
      [`GET /rooms/${GAME_ID}`]: () => {
        if (unavailable) throw new Error("offline");
        return jsonResponse(joined);
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    vi.stubGlobal("WebSocket", Socket);
    const { router } = renderApp(options, {
      initialEntries: [`/games/${GAME_ID}`],
      configureRoutes(routes) {
        const history = routes
          .flatMap(function flatten(route): RouteObject[] {
            return [route, ...(route.children?.flatMap(flatten) ?? [])];
          })
          .find((route) => route.id === "history");
        if (!history) throw new Error("Missing history test route");
        history.loader = () => slow.promise;
      },
    });
    await screen.findByRole("grid");
    await waitFor(() => expect(Socket.instances.length).toBe(1));
    act(() => Socket.instances[0]!.frame({ protocol: 1, type: "snapshot", room: joined }));
    unavailable = true;
    await act(() => router.revalidate());
    expect(screen.getByRole("grid")).toBeVisible();
    expect(Socket.instances.length).toBe(1);
    unavailable = false;
    const analysisReads = () =>
      http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("/analysis")).length;
    const savedReads = analysisReads();
    await act(() => router.revalidate());
    expect(analysisReads()).toBe(savedReads);
    let pending = Promise.resolve();
    await act(async () => {
      pending = router.navigate("/history");
    });
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    await act(() => router.navigate(`/games/${GAME_ID}`));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeVisible();
    await act(async () => {
      slow.resolve(null);
      await pending;
    });
    unavailable = true;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Retry loading" })).toBeVisible();
    unavailable = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry loading" }));
    expect(await screen.findByRole("grid")).toBeVisible();
    http.assertNoUnexpectedRequests();
  });
  it("preserves only the issued invitation through StrictMode's initial game handoff", async () => {
    const waiting = waitingRoom("black");
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(roomSession),
      "GET /profile": () => jsonResponse(roomProfile),
      "GET /games/unfinished": () => jsonResponse({ game: null }),
      "POST /rooms/creation-operation": () =>
        jsonResponse({ operationId: GAME_ID, expiresAt: "2027-01-01T00:00:00.000Z" }),
      "POST /rooms": () => jsonResponse({ room: waiting, invitation: INVITATION }),
    });
    vi.stubGlobal("fetch", http.fetch);
    vi.stubGlobal("WebSocket", Socket);
    const { router } = renderApp(options, { strict: true, initialEntries: ["/rooms"] });
    await userEvent.click(await screen.findByRole("button", { name: "Create room" }));
    expect(await screen.findByRole("textbox", { name: /^Invitation link$/ })).toHaveValue(
      `http://localhost:3000/rooms/join#invite=${INVITATION}`,
    );
    expect(JSON.stringify(router.state.loaderData)).not.toContain(INVITATION);
    expect(JSON.stringify(router.state.location.state)).not.toContain(INVITATION);
    http.assertNoUnexpectedRequests();
  });
  it("exposes room entry and keeps visiting a guest invitation read-only", async () => {
    const http = createHttpMock({ "GET /api/auth/get-session": () => jsonResponse(null) });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: ["/rooms"] });
    expect(await screen.findByRole("heading", { name: "Private human game" })).toBeVisible();
    await userEvent.click(screen.getByRole("link", { name: "Join with an invitation" }));
    expect(await screen.findByRole("textbox", { name: "Invitation link or code" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/rooms/join");
    expect(
      http.fetch.mock.calls.every(([url]) => requestPath(url) === "/api/auth/get-session"),
    ).toBe(true);
    http.assertNoUnexpectedRequests();
  });
  it("dispatches Black-owner waiting to live play without recreating its socket on revalidation", async () => {
    const waiting = waitingRoom("black");
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(roomSession),
      "GET /profile": () => jsonResponse(roomProfile),
      [`GET /games/${GAME_ID}/details`]: () =>
        jsonResponse({ snapshot: waiting.snapshot, configuration }),
      [`GET /rooms/${GAME_ID}`]: () => jsonResponse(waiting),
    });
    vi.stubGlobal("fetch", http.fetch);
    vi.stubGlobal("WebSocket", Socket);
    const { router } = renderApp(options, { initialEntries: [`/games/${GAME_ID}`] });
    expect(await screen.findByRole("heading", { name: "Waiting for opponent" })).toBeVisible();
    await waitFor(() => expect(Socket.instances.length).toBe(1));
    const socket = Socket.instances[0]!;
    const joined = {
      ...joinedRoom(),
      viewer: { color: "black" as const, isOwner: true },
      capabilities: { canMove: false, canResign: true, canClose: true, canManageInvitation: false },
    };
    act(() => socket.frame({ protocol: 1, type: "snapshot", room: joined }));
    expect(await screen.findByRole("button", { name: "Resign" })).toBeVisible();
    const close = screen.getByRole("button", { name: "Close room" });
    close.focus();
    act(() =>
      socket.frame({
        protocol: 1,
        type: "update",
        room: {
          ...joined,
          snapshot: snapshot(["e2e4"], { version: 2 }),
          capabilities: { ...joined.capabilities, canMove: true },
        },
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("e4");
    act(() =>
      socket.frame({
        protocol: 1,
        type: "update",
        room: { ...joined, snapshot: snapshot(["e2e4", "f7f6", "d1h5"], { version: 4 }) },
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Check.");
    await act(() => router.revalidate());
    expect(close).toHaveFocus();
    expect(Socket.instances.length).toBe(1);
    expect(screen.queryByRole("heading", { name: "Waiting for opponent" })).not.toBeInTheDocument();
    expect(http.fetch.mock.calls.map(([url]) => requestPath(url))).not.toContain("/credentials");
    http.assertNoUnexpectedRequests();
  });
  it("loads direct terminal room links with replay and no AI or credential requests", async () => {
    const terminal = { ...joinedRoom(), snapshot: snapshot(FOOLS_MATE, { version: 5 }) };
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(roomSession),
      "GET /profile": () => jsonResponse(roomProfile),
      [`GET /games/${GAME_ID}/details`]: () =>
        jsonResponse({ snapshot: terminal.snapshot, configuration }),
      [`GET /rooms/${GAME_ID}`]: () => jsonResponse(terminal),
      [`GET /games/${GAME_ID}/replay`]: () =>
        jsonResponse({ snapshot: terminal.snapshot, initialFen: snapshot().fen }),
    });
    vi.stubGlobal("fetch", http.fetch);
    vi.stubGlobal("WebSocket", Socket);
    renderApp(options, { initialEntries: [`/games/${GAME_ID}`] });
    expect(await screen.findByRole("button", { name: "Download PGN" })).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^First$/ })).toHaveAttribute(
        "aria-disabled",
        "false",
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Black wins by checkmate");
    await userEvent.click(screen.getByRole("button", { name: /^First$/ }));
    expect(await screen.findByText("Ply 0 of 4")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Ply 0 of 4");
    expect(screen.queryByRole("button", { name: "Resign" })).not.toBeInTheDocument();
    http.assertNoUnexpectedRequests();
  });
});
