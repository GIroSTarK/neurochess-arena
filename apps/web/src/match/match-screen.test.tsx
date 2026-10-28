import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GAME_ID, jsonResponse, requestBody, requestPath, snapshot } from "../test/fixtures";
import { createHttpMock } from "../test/http";
import { renderApp } from "../test/render";

describe("Arena route lifetime", () => {
  let http: ReturnType<typeof createHttpMock>;
  afterEach(() => http.assertNoUnexpectedRequests());

  it.each([
    { human: "white", moves: [], canStep: false },
    { human: "white", moves: ["f2f3"], canStep: true },
    { human: "black", moves: [], canStep: true },
    { human: "black", moves: ["f2f3"], canStep: false },
    { human: null, moves: [], canStep: true },
  ] as const)(
    "keeps $human controls and orientation with paused AI stepping $canStep",
    async ({ human, moves, canStep }) => {
      const user = userEvent.setup();
      let stored = snapshot(moves, { state: "paused", legalMoves: [] });
      const ai = { type: "ai", provider: "openai", modelId: "fixture", parameters: {} };
      http = createHttpMock({
        "GET /api/auth/get-session": () => jsonResponse(null),
        [`GET /games/${GAME_ID}/details`]: () =>
          jsonResponse({
            snapshot: stored,
            configuration: {
              mode: human ? "ai_vs_human" : "ai_vs_ai",
              seats: {
                white: human === "white" ? { type: "human" } : ai,
                black: human === "black" ? { type: "human" } : ai,
              },
            },
          }),
        [`GET /games/${GAME_ID}/invocations`]: () =>
          jsonResponse({ gameId: GAME_ID, version: stored.version, turns: [] }),
        [`POST /games/${GAME_ID}/lifecycle`]: (init) => {
          expect(JSON.parse(requestBody(init))).toMatchObject({ action: "pause" });
          stored = { ...stored, version: stored.version + 1 };
          return jsonResponse(stored);
        },
      });
      vi.stubGlobal("fetch", http.fetch);
      renderApp(
        { apiBaseUrl: "http://localhost:3001", sandboxEnabled: false },
        { initialEntries: [`/games/${GAME_ID}`] },
      );
      const controls = await screen.findByRole("region", { name: "Game controls" });
      const step = within(controls).getByRole("button", { name: "Next move" });
      expect(step).toHaveAttribute("aria-disabled", "true");
      await user.click(await screen.findByRole("button", { name: "Restore keys" }));
      for (const input of await screen.findAllByLabelText(/· OpenAI · API key/, { exact: false })) {
        await user.type(input, "fixture-key");
      }
      await user.click(screen.getByRole("button", { name: "Keep paused" }));
      expect(step).toHaveAttribute("aria-disabled", String(!canStep));
      const resignations = within(controls).queryAllByRole("button", { name: /^Resign / });
      expect(resignations).toHaveLength(human ? 1 : 0);
      if (human) {
        expect(resignations[0]).toHaveTextContent(
          human === "white" ? "Resign White" : "Resign Black",
        );
        await user.click(resignations[0]!);
        expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
        await user.keyboard("{Escape}");
        expect(resignations[0]).toHaveFocus();
      }
      const board = screen.getByRole("grid");
      expect(board.querySelector("[data-square]")).toHaveAttribute(
        "data-square",
        human === "black" ? "h1" : "a8",
      );
      const pacing = screen.getByRole("combobox", { name: "Delay between moves" });
      expect(
        within(pacing)
          .getAllByRole("option")
          .map((option) => option.getAttribute("value")),
      ).toEqual(["500", "1500", "5000"]);
      for (const value of ["500", "5000", "1500"]) {
        await user.selectOptions(pacing, value);
        expect(pacing).toHaveValue(value);
      }
      await user.click(screen.getByRole("button", { name: "Flip board" }));
      expect(screen.getByRole("grid")).toBe(board);
      expect(pacing).toHaveValue("1500");
      expect(http.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);

      const play = screen.getByRole("region", { name: "Play area" });
      const status = within(play).getByRole("heading", { name: "Game paused" });
      const evaluation = within(play).getByRole("region", { name: "Stockfish evaluation" });
      expect(status.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(
        board.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        controls.compareDocumentPosition(evaluation) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        evaluation.compareDocumentPosition(pacing) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(within(controls).queryByRole("combobox")).not.toBeInTheDocument();
    },
  );

  it("reconnects setup to the new credential owner on same-document history entry", async () => {
    window.history.replaceState(null, "", "/");
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      "GET /games/unfinished": () => jsonResponse({ game: null }),
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: false });
    const key = () =>
      within(screen.getByRole("group", { name: "White" })).getByLabelText("API key", {
        exact: true,
      });
    await screen.findByRole("heading", { name: "Set up a game" });
    await waitFor(() => expect(key()).not.toHaveAttribute("readonly"));
    await act(() => router.navigate("/history"));
    await act(() => router.navigate(-1));
    await screen.findByRole("heading", { name: "Set up a game" });
    await waitFor(() =>
      expect(
        http.fetch.mock.calls.filter(([url]) => requestPath(url) === "/games/unfinished"),
      ).toHaveLength(2),
    );
    expect(key()).not.toHaveAttribute("readonly");
  });

  it("recovers once under StrictMode and recovers again without keys after bfcache restoration", async () => {
    window.history.replaceState(null, "", "/games/" + GAME_ID);
    let stored = snapshot();
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      [`GET /games/${GAME_ID}/details`]: () =>
        jsonResponse({
          snapshot: stored,
          configuration: {
            mode: "ai_vs_human",
            seats: {
              white: { type: "human" },
              black: { type: "ai", provider: "openai", modelId: "fixture", parameters: {} },
            },
          },
        }),
      [`GET /games/${GAME_ID}/invocations`]: () =>
        jsonResponse({ gameId: GAME_ID, version: stored.version, turns: [] }),
      [`POST /games/${GAME_ID}/lifecycle`]: () => {
        stored = snapshot([], { state: "paused", legalMoves: [], version: stored.version + 1 });
        return jsonResponse(stored);
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    const { unmount } = renderApp(
      { apiBaseUrl: "http://localhost:3001", sandboxEnabled: false },
      { strict: true },
    );
    await screen.findByRole("button", { name: "Resume" });
    const pauses = () =>
      http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("/lifecycle"));
    expect(pauses()).toHaveLength(1);
    await act(() => fireEvent(window, new PageTransitionEvent("pagehide", { persisted: true })));
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    await act(() => fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true })));
    await waitFor(() => expect(pauses()).toHaveLength(2));
    expect(await screen.findByRole("button", { name: "Resume" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    unmount();
    const requests = http.fetch.mock.calls.length;
    await act(() => fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true })));
    expect(http.fetch).toHaveBeenCalledTimes(requests);
  });
});
