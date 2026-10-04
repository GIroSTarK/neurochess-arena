import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  errorResponse,
  GAME_ID,
  jsonResponse,
  OTHER_GAME_ID,
  requestBody,
  requestPath,
  snapshot,
} from "../test/fixtures";
import { createHttpMock } from "../test/http";
import { renderApp } from "../test/render";

const options = { apiBaseUrl: "http://localhost:3001", sandboxEnabled: true };
const gamePath = "/sandbox/games/" + GAME_ID;
const apiPath = "/games/" + GAME_ID;

describe("committed Sandbox route data", () => {
  let http: ReturnType<typeof createHttpMock>;
  afterEach(() => http.assertNoUnexpectedRequests());
  const reads = (path: string) =>
    http.fetch.mock.calls.filter(([url]) => requestPath(url) === path);

  it("loads an empty anonymous entry once in StrictMode and bootstraps only on Start", async () => {
    http = createHttpMock({
      "GET /ready": () => jsonResponse({ status: "ready" }),
      "GET /sandbox/games/unfinished": () => errorResponse("UNAUTHORIZED", 401),
      "POST /guest-session": () => jsonResponse({ status: "ready" }),
      "POST /sandbox/games": () => jsonResponse(snapshot(), 201),
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: ["/sandbox"], strict: true });
    await screen.findByRole("button", { name: "Start sandbox" });
    expect(router.state.loaderData["sandbox-entry"]).toMatchObject({
      kind: "entry",
      entry: { target: { kind: "none" }, snapshot: null, readiness: true },
    });
    expect(reads("/ready")).toHaveLength(1);
    expect(reads("/sandbox/games/unfinished")).toHaveLength(1);
    expect(reads("/guest-session")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Start sandbox" }));
    await screen.findByRole("button", { name: "Pause" });
    await waitFor(() => expect(router.state.location.pathname).toBe(gamePath));
    expect(router.state.historyAction).toBe("PUSH");
    expect(router.state.loaderData["sandbox-game"]).toEqual({ kind: "handoff", gameId: GAME_ID });
    expect(reads("/ready")).toHaveLength(1);
    expect(reads(apiPath)).toHaveLength(0);
    expect(reads(apiPath + "/lifecycle")).toHaveLength(0);
    expect(router.state.location.state).toBeNull();
  });

  it("replaces discovered recovery with a handoff and does not repeat it on revalidation", async () => {
    let stored = snapshot(["e2e4"]);
    http = createHttpMock({
      "GET /ready": () => jsonResponse({ status: "ready" }),
      "GET /sandbox/games/unfinished": () => jsonResponse({ snapshot: stored }),
      [`GET ${apiPath}`]: () => jsonResponse(stored),
      [`POST ${apiPath}/lifecycle`]: () => {
        stored = snapshot(["e2e4"], { state: "paused", legalMoves: [], version: 2 });
        return jsonResponse(stored);
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: ["/sandbox"], strict: true });
    await screen.findByRole("button", { name: "Resume" });
    await waitFor(() => expect(router.state.location.pathname).toBe(gamePath));
    expect(router.state.historyAction).toBe("REPLACE");
    expect(reads(apiPath)).toHaveLength(0);
    expect(reads(apiPath + "/lifecycle")).toHaveLength(1);
    stored = snapshot(["e2e4", "e7e5"], { version: 3 });
    await act(() => router.revalidate());
    expect(reads(apiPath)).toHaveLength(1);
    expect(reads(apiPath + "/lifecycle")).toHaveLength(1);
    expect(screen.getByRole("grid")).toHaveAttribute("data-fen", snapshot(["e2e4"]).fen);
    expect(screen.getByRole("button", { name: "Resume" })).toBeVisible();
  });

  it("updates readiness from explicit loader revalidation", async () => {
    let ready = false;
    http = createHttpMock({
      "GET /ready": () =>
        ready ? jsonResponse({ status: "ready" }) : Promise.reject(new Error("offline")),
      "GET /sandbox/games/unfinished": () => jsonResponse({ snapshot: null }),
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: ["/sandbox"] });
    await screen.findByRole("button", { name: "Start sandbox" });
    expect(screen.getByRole("button", { name: "Start sandbox" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    ready = true;
    await act(() => router.revalidate());
    expect(screen.getByRole("button", { name: "Start sandbox" })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    expect(reads("/ready")).toHaveLength(2);
    expect(reads("/sandbox/games/unfinished")).toHaveLength(2);
  });

  it("cancels an uncommitted entry read and never pauses its late result", async () => {
    const pending = Promise.withResolvers<Response>();
    let readSignal: AbortSignal | null | undefined;
    http = createHttpMock({
      "GET /ready": () => jsonResponse({ status: "ready" }),
      "GET /sandbox/games/unfinished": () => jsonResponse({ snapshot: null }),
      [`GET ${apiPath}`]: (init) => {
        readSignal = init?.signal;
        return pending.promise;
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: ["/sandbox"] });
    await screen.findByRole("button", { name: "Start sandbox" });
    let opening: Promise<void>;
    await act(async () => {
      opening = router.navigate(gamePath);
    });
    await waitFor(() => expect(readSignal).toBeDefined());
    expect(router.state.location.pathname).toBe("/sandbox");
    await act(() => router.navigate("/missing"));
    expect(readSignal?.aborted).toBe(true);
    await act(async () => {
      pending.resolve(jsonResponse(snapshot()));
      await opening;
    });
    expect(router.state.location.pathname).toBe("/missing");
    expect(reads(apiPath + "/lifecycle")).toHaveLength(0);
  });

  it("retries failed entry reads through the loader without retaining raw errors", async () => {
    let failed = true;
    http = createHttpMock({
      "GET /ready": () => jsonResponse({ status: "ready" }),
      [`GET ${apiPath}`]: () => {
        if (failed) throw new Error("private-sandbox-error-canary");
        return jsonResponse(snapshot([], { state: "paused", legalMoves: [], version: 1 }));
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: [gamePath] });
    await screen.findByRole("button", { name: "Retry recovery" });
    expect(router.state.loaderData["sandbox-game"]).toMatchObject({
      kind: "entry",
      entry: { issue: { phase: "recovery-required", notice: "network" } },
    });
    expect(JSON.stringify(router.state.loaderData)).not.toContain("private-sandbox-error-canary");
    failed = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry recovery" }));
    await screen.findByRole("button", { name: "Resume" });
    expect(reads(apiPath)).toHaveLength(2);
    expect(router.state.loaderData["sandbox-game"]).toMatchObject({
      kind: "entry",
      entry: { snapshot: { gameId: GAME_ID, state: "paused" } },
    });
  });

  it("clears private game data when revalidation denies guest access", async () => {
    let denied = false;
    http = createHttpMock({
      "GET /ready": () => jsonResponse({ status: "ready" }),
      [`GET ${apiPath}`]: () =>
        denied
          ? errorResponse("NOT_FOUND", 404)
          : jsonResponse(snapshot(["e2e4"], { state: "paused", legalMoves: [], version: 2 })),
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: [gamePath] });
    await screen.findByRole("button", { name: "Resume" });
    denied = true;
    await act(() => router.revalidate());
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
    expect(screen.getByRole("grid")).toHaveAttribute("data-fen", snapshot().fen);
    expect(screen.getByRole("button", { name: "Start sandbox again" })).toBeVisible();
    expect(JSON.stringify(router.state.loaderData)).not.toContain(snapshot(["e2e4"]).fen);
  });

  it("keeps an uncertain recovery command across revalidation and retries its exact payload", async () => {
    const commands: string[] = [];
    http = createHttpMock({
      "GET /ready": () => jsonResponse({ status: "ready" }),
      [`GET ${apiPath}`]: () => jsonResponse(snapshot()),
      [`POST ${apiPath}/lifecycle`]: (init) => {
        commands.push(requestBody(init));
        if (commands.length === 1) throw new Error("lost acknowledgement");
        return jsonResponse(snapshot([], { state: "paused", legalMoves: [], version: 1 }));
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: [gamePath] });
    await screen.findByRole("button", { name: "Retry same command" });
    await act(() => router.revalidate());
    expect(commands).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Retry same command" }));
    await screen.findByRole("button", { name: "Resume" });
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(commands[0]);
  });

  it("reloads through the loader on persisted pageshow and when switching game parameters", async () => {
    let stored = snapshot([], { state: "paused", legalMoves: [], version: 1 });
    const other = snapshot(["e2e4"], {
      gameId: OTHER_GAME_ID,
      state: "paused",
      legalMoves: [],
      version: 2,
    });
    http = createHttpMock({
      "GET /ready": () => jsonResponse({ status: "ready" }),
      [`GET ${apiPath}`]: () => jsonResponse(stored),
      [`GET /games/${OTHER_GAME_ID}`]: () => jsonResponse(other),
      [`POST ${apiPath}/lifecycle`]: () => {
        stored = snapshot([], { state: "paused", legalMoves: [], version: 3 });
        return jsonResponse(stored);
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: [gamePath], strict: true });
    await screen.findByRole("button", { name: "Resume" });
    stored = snapshot([], { version: 2 });
    await act(() => fireEvent(window, new PageTransitionEvent("pagehide", { persisted: true })));
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    await act(() => fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true })));
    await screen.findByRole("button", { name: "Resume" });
    expect(reads(apiPath)).toHaveLength(2);
    expect(reads(apiPath + "/lifecycle")).toHaveLength(1);
    await act(() => router.navigate("/sandbox/games/" + OTHER_GAME_ID));
    await waitFor(() => expect(screen.getByRole("grid")).toHaveAttribute("data-fen", other.fen));
    await act(() => router.navigate(-1));
    await waitFor(() => expect(screen.getByRole("grid")).toHaveAttribute("data-fen", stored.fen));
    expect(reads(apiPath)).toHaveLength(3);
  });
});
