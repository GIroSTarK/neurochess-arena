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

const options = { apiBaseUrl: "http://localhost:3001", sandboxEnabled: false };
const gamePath = "/games/" + GAME_ID;
const configuration = {
  mode: "ai_vs_human",
  seats: {
    white: { type: "human" },
    black: { type: "ai", provider: "openai", modelId: "fixture", parameters: {} },
  },
} as const;
const session = {
  user: { id: OTHER_GAME_ID, email: "player@example.com", emailVerified: true },
  session: { expiresAt: "2027-10-01T00:00:00.000Z" },
};
const profile = {
  username: "Player",
  completed: true,
  avatar: { source: "initials", initials: "PL" },
};

describe("committed Arena route data", () => {
  let http: ReturnType<typeof createHttpMock>;
  afterEach(() => {
    http.assertNoUnexpectedRequests();
    sessionStorage.clear();
  });

  it("shows authorized wrong-mode guidance without reading account credentials", async () => {
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse(profile),
      [`GET ${gamePath}/details`]: () =>
        jsonResponse({ snapshot: snapshot(), configuration: null }),
    });
    vi.stubGlobal("fetch", http.fetch);
    renderApp({ ...options, sandboxEnabled: true }, { initialEntries: [gamePath] });
    expect(await screen.findByRole("link", { name: "Return to Sandbox" })).toHaveAttribute(
      "href",
      "/sandbox/games/" + GAME_ID,
    );
    expect(http.fetch.mock.calls.some(([url]) => requestPath(url) === "/credentials")).toBe(false);
  });

  it("loads account setup and its masked catalog once even in StrictMode", async () => {
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse(profile),
      "GET /games/unfinished": () => jsonResponse({ game: null }),
      "GET /credentials": () => jsonResponse({ credentials: [] }),
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: ["/"], strict: true });
    await screen.findByRole("heading", { name: "Set up a game" });
    const reads = (path: string) =>
      http.fetch.mock.calls.filter(([url]) => requestPath(url) === path);
    expect(reads("/games/unfinished")).toHaveLength(1);
    expect(reads("/credentials")).toHaveLength(1);
    expect(router.state.loaderData["arena-entry"]).toMatchObject({
      data: { entry: { kind: "setup" }, credentials: { phase: "ready", credentials: [] } },
    });
  });

  it("retries a failed entry through fresh loader data, then recovers only once", async () => {
    let failed = true;
    let stored = snapshot();
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      [`GET ${gamePath}/details`]: () => {
        if (failed) throw new Error("untrusted-read-canary");
        return jsonResponse({ snapshot: stored, configuration });
      },
      [`GET ${gamePath}/invocations`]: () =>
        jsonResponse({ gameId: GAME_ID, version: stored.version, turns: [] }),
      [`POST ${gamePath}/lifecycle`]: () => {
        stored = snapshot([], { state: "paused", legalMoves: [], version: stored.version + 1 });
        return jsonResponse(stored);
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: [gamePath] });
    await screen.findByRole("button", { name: "Retry loading" });
    expect(router.state.loaderData["arena-game"]).toMatchObject({
      data: { entry: { kind: "unavailable", code: "unavailable" } },
    });
    expect(JSON.stringify(router.state.loaderData)).not.toContain("untrusted-read-canary");
    failed = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry loading" }));
    await screen.findByRole("button", { name: "Resume" });
    expect(router.state.loaderData["arena-game"]).toMatchObject({
      data: { entry: { kind: "game", gameId: GAME_ID } },
    });
    expect(
      http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("/details")),
    ).toHaveLength(2);
    expect(
      http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("/lifecycle")),
    ).toHaveLength(1);
    await act(() => router.revalidate());
    expect(
      http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("/lifecycle")),
    ).toHaveLength(1);
  });

  it("does not recover a game until its loader has committed, and cancels its read on departure", async () => {
    const pending = Promise.withResolvers<Response>();
    let readSignal: AbortSignal | null | undefined;
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      "GET /games/unfinished": () => jsonResponse({ game: null }),
      [`GET ${gamePath}/details`]: (init) => {
        readSignal = init?.signal;
        return pending.promise;
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: ["/"] });
    await screen.findByRole("heading", { name: "Set up a game" });
    let opening: Promise<void>;
    await act(async () => {
      opening = router.navigate(gamePath);
    });
    await waitFor(() => expect(readSignal).toBeDefined());
    expect(router.state.location.pathname).toBe("/");
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    await act(() => router.navigate("/history"));
    expect(readSignal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve(jsonResponse({ snapshot: snapshot(), configuration }));
      await opening;
    });
    expect(router.state.location.pathname).toBe("/history");
    expect(http.fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("clears a previously visible game when a fresh entry read denies private access", async () => {
    let denied = false;
    let stored = snapshot();
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      [`GET ${gamePath}/details`]: () =>
        denied
          ? errorResponse("NOT_FOUND", 404)
          : jsonResponse({ snapshot: stored, configuration }),
      [`GET ${gamePath}/invocations`]: () =>
        jsonResponse({ gameId: GAME_ID, version: stored.version, turns: [] }),
      [`POST ${gamePath}/lifecycle`]: () => {
        stored = snapshot([], { state: "paused", legalMoves: [], version: stored.version + 1 });
        return jsonResponse(stored);
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: [gamePath] });
    await screen.findByRole("button", { name: "Resume" });
    denied = true;
    await act(() => router.revalidate());
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(
      http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("/lifecycle")),
    ).toHaveLength(1);
  });

  it("resolves a replacement identity after it cancels a pending game read", async () => {
    let currentSession = session;
    let delayed = false;
    let stored = snapshot();
    const pending = Promise.withResolvers<Response>();
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(currentSession),
      "GET /profile": () => jsonResponse(profile),
      "GET /credentials": () => jsonResponse({ credentials: [] }),
      [`GET ${gamePath}/details`]: (init) => {
        if (new Headers(init?.headers).get("x-neurochess-expected-account") === GAME_ID) {
          return errorResponse("NOT_FOUND", 404);
        }
        return delayed ? pending.promise : jsonResponse({ snapshot: stored, configuration });
      },
      [`GET ${gamePath}/invocations`]: () =>
        jsonResponse({ gameId: GAME_ID, version: stored.version, turns: [] }),
      [`POST ${gamePath}/lifecycle`]: () => {
        stored = snapshot([], { state: "paused", legalMoves: [], version: stored.version + 1 });
        return jsonResponse(stored);
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: [gamePath] });
    await screen.findByRole("button", { name: "Resume" });
    const issued: unknown = router.state.loaderData["arena-game"];
    delayed = true;
    let reading: Promise<void>;
    await act(async () => {
      reading = router.revalidate();
    });
    await waitFor(() =>
      expect(
        http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("/details")),
      ).toHaveLength(2),
    );
    const channel = new BroadcastChannel("neurochess.identity");
    try {
      currentSession = { ...session, user: { ...session.user, id: GAME_ID } };
      await act(async () => channel.postMessage("changed"));
      await waitFor(() =>
        expect(
          http.fetch.mock.calls.filter(([url]) => requestPath(url) === "/api/auth/get-session")
            .length,
        ).toBeGreaterThanOrEqual(4),
      );
      expect(issued).toMatchObject({ data: null });
      expect(screen.queryByRole("grid")).not.toBeInTheDocument();
      await act(async () => {
        pending.resolve(jsonResponse({ snapshot: stored, configuration }));
        await reading;
      });
      expect(
        await screen.findByText(
          "This private game is unavailable to your session. Keys have been cleared.",
          { selector: "p" },
        ),
      ).toBeVisible();
      expect(router.state.loaderData["arena-game"]).toMatchObject({
        data: { entry: { kind: "unavailable", code: "access" } },
      });
    } finally {
      channel.close();
    }
  });
});
