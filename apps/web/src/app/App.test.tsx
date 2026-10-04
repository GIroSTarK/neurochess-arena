import { moveCommandSchema } from "@neurochess/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWebI18n } from "../i18n";
import {
  errorResponse,
  FOOLS_MATE,
  GAME_ID,
  jsonResponse,
  OTHER_GAME_ID,
  requestBody,
  requestPath,
  snapshot,
} from "../test/fixtures";
import { createHttpMock, type HttpRoutes } from "../test/http";
import { square, squaresOnBoard } from "../test/queries";
import { renderApp } from "../test/render";

let http: ReturnType<typeof createHttpMock>;

function mockApi(routes: HttpRoutes = {}) {
  http = createHttpMock({
    "GET /ready": () => jsonResponse({ status: "ready" }),
    "GET /sandbox/games/unfinished": () => jsonResponse({ snapshot: null }),
    "POST /guest-session": () => jsonResponse({ status: "ready" }),
    "POST /sandbox/games": () => jsonResponse(snapshot(), 201),
    [`POST /games/${GAME_ID}/moves`]: () => jsonResponse(snapshot(["e2e4"])),
    [`GET /games/${GAME_ID}/replay`]: () =>
      jsonResponse({ snapshot: snapshot(FOOLS_MATE), initialFen: snapshot().fen }),
    ...routes,
  });
  vi.stubGlobal("fetch", http.fetch);
  return http.fetch;
}

async function start() {
  const entry = within(await screen.findByRole("region", { name: "Ready when you are" }));
  const button = entry.getByRole("button", { name: "Start sandbox" });
  await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "false"));
  await userEvent.click(button);
  await waitFor(() => expect(button).not.toBeInTheDocument());
  await waitFor(() => expect(screen.queryByText("Opening page…")).not.toBeInTheDocument());
}

describe("localized sandbox application", () => {
  beforeEach(() => window.history.replaceState(null, "", "/sandbox"));
  afterEach(() => http.assertNoUnexpectedRequests());
  it("boots only on action under Strict Mode and orders cookie bootstrap before creation", async () => {
    const bootstrap = Promise.withResolvers<Response>();
    const fetch = mockApi({ "POST /guest-session": () => bootstrap.promise });
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: true }, { strict: true });
    expect(await screen.findByRole("heading", { name: "Sandbox" })).toBeInTheDocument();
    const preview = await screen.findByRole("grid", { name: "Chessboard" });
    const square = squaresOnBoard(preview);
    expect(preview).toHaveAttribute("aria-readonly", "true");
    expect(preview).toHaveAttribute("data-fen", snapshot().fen);
    expect(screen.queryByRole("region", { name: "Move history" })).not.toBeInTheDocument();
    await userEvent.click(square("e2"));
    await userEvent.click(square("e4"));
    expect(preview).toHaveAttribute("data-fen", snapshot().fen);
    const button = await screen.findByRole("button", { name: "Start sandbox" });
    await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "false"));
    expect(
      fetch.mock.calls.every(([url]) =>
        ["/ready", "/sandbox/games/unfinished"].includes(requestPath(url)),
      ),
    ).toBe(true);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetch.mock.calls.filter(([url]) => requestPath(url) === "/guest-session")).toHaveLength(
      1,
    );
    expect(fetch.mock.calls.filter(([url]) => requestPath(url) === "/sandbox/games")).toHaveLength(
      0,
    );
    await act(async () => bootstrap.resolve(jsonResponse({ status: "ready" })));
    await screen.findByRole("button", { name: "Pause" });
    expect(fetch.mock.calls.filter(([url]) => requestPath(url) === "/sandbox/games")).toHaveLength(
      1,
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("grid")).toHaveAccessibleDescription(/arrow keys/);
  });

  it("keeps the accepted board, turn and history while submitting and announces confirmation once", async () => {
    const pending = Promise.withResolvers<Response>();
    mockApi({ [`POST /games/${GAME_ID}/moves`]: () => pending.promise });
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: true });
    await start();
    const square = squaresOnBoard();
    const live = screen.getByRole("status");
    const announcements: string[] = [];
    const observer = new MutationObserver(() => announcements.push(live.textContent));
    observer.observe(live, { childList: true, characterData: true, subtree: true });
    await userEvent.click(square("e2"));
    await userEvent.click(square("e4"));
    expect(screen.getByText("Submitting your move…")).toBeInTheDocument();
    expect(square("e2")).toHaveAccessibleName(/White pawn/);
    expect(square("e4")).toHaveAccessibleName(/empty/);
    expect(screen.getByRole("heading", { name: "White to move" })).toBeInTheDocument();
    expect(screen.getByText("0 plies")).toBeInTheDocument();
    await act(async () => pending.resolve(jsonResponse(snapshot(["e2e4"]))));
    await waitFor(() => expect(live).toHaveTextContent("White played e4. Black to move"));
    expect(square("e4")).toHaveFocus();
    expect(square("e4")).toHaveAccessibleName(/White pawn/);
    await userEvent.click(screen.getByRole("button", { name: "Flip board" }));
    expect(announcements.filter((message) => message.includes("White played e4"))).toHaveLength(1);
    expect(live.closest("[aria-busy=true]")).toBeNull();
    observer.disconnect();
  });

  it("keeps the same focused control during delayed Pause and Resume commands", async () => {
    const pause = Promise.withResolvers<Response>();
    const resume = Promise.withResolvers<Response>();
    let requests = 0;
    mockApi({
      [`POST /games/${GAME_ID}/lifecycle`]: () =>
        ++requests === 1 ? pause.promise : resume.promise,
    });
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: true });
    await start();
    const user = userEvent.setup();
    const controls = within(screen.getByRole("group", { name: "Game controls" }));
    const control = controls.getByRole("button", { name: "Pause" });
    act(() => control.focus());

    await user.keyboard("{Enter}");
    expect(control).toHaveFocus();
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(control).not.toBeDisabled();
    await act(async () =>
      pause.resolve(jsonResponse(snapshot([], { state: "paused", legalMoves: [], version: 1 }))),
    );
    expect(await controls.findByRole("button", { name: "Resume" })).toBe(control);
    expect(control).not.toHaveAttribute("aria-disabled", "true");
    expect(control).toHaveFocus();

    await user.keyboard(" ");
    expect(control).toHaveFocus();
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(control).not.toBeDisabled();
    await act(async () => resume.resolve(jsonResponse(snapshot([], { version: 2 }))));
    expect(await controls.findByRole("button", { name: "Pause" })).toBe(control);
    expect(control).not.toHaveAttribute("aria-disabled", "true");
    expect(control).toHaveFocus();
    expect(requests).toBe(2);
  });

  it("blocks repeat lifecycle activation and destructive dialogs while a command is pending", async () => {
    const pending = Promise.withResolvers<Response>();
    const fetch = mockApi({ [`POST /games/${GAME_ID}/lifecycle`]: () => pending.promise });
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: true });
    await start();
    const user = userEvent.setup();
    const controls = within(screen.getByRole("group", { name: "Game controls" }));
    await user.click(controls.getByRole("button", { name: "Pause" }));

    for (const name of ["Pause", "Abort game", "Resign White", "Resign Black"]) {
      const control = controls.getByRole("button", { name });
      expect(control).toHaveAttribute("aria-disabled", "true");
      await user.click(control);
      await user.keyboard("{Enter} ");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    }
    expect(
      fetch.mock.calls.filter(([url]) => requestPath(url) === `/games/${GAME_ID}/lifecycle`),
    ).toHaveLength(1);
    await act(async () =>
      pending.resolve(jsonResponse(snapshot([], { state: "paused", legalMoves: [], version: 1 }))),
    );
    await controls.findByRole("button", { name: "Resume" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not steal board focus when a delayed Pause or Resume completes", async () => {
    const pause = Promise.withResolvers<Response>();
    const resume = Promise.withResolvers<Response>();
    let requests = 0;
    mockApi({
      [`POST /games/${GAME_ID}/lifecycle`]: () =>
        ++requests === 1 ? pause.promise : resume.promise,
    });
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: true });
    await start();
    const square = squaresOnBoard();
    const controls = within(screen.getByRole("group", { name: "Game controls" }));

    await userEvent.click(controls.getByRole("button", { name: "Pause" }));
    await userEvent.click(square("e2"));
    expect(square("e2")).toHaveFocus();
    await act(async () =>
      pause.resolve(jsonResponse(snapshot([], { state: "paused", legalMoves: [], version: 1 }))),
    );
    await controls.findByRole("button", { name: "Resume" });
    expect(square("e2")).toHaveFocus();

    await userEvent.click(controls.getByRole("button", { name: "Resume" }));
    await userEvent.click(square("e2"));
    expect(square("e2")).toHaveFocus();
    await act(async () => resume.resolve(jsonResponse(snapshot([], { version: 2 }))));
    await controls.findByRole("button", { name: "Pause" });
    expect(square("e2")).toHaveFocus();
  });

  it("adopts a conflict without replay or server prose and clears stale selection", async () => {
    const current = snapshot(["d2d4"]);
    const fetch = mockApi({
      [`POST /games/${GAME_ID}/moves`]: () => errorResponse("GAME_CONFLICT", 409, current),
    });
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: true });
    await start();
    const square = squaresOnBoard();
    await userEvent.click(square("e2"));
    await userEvent.click(square("e4"));
    await waitFor(() => expect(square("d4")).toHaveAccessibleName(/White pawn/));
    expect(square("e2")).not.toHaveAttribute("data-selected");
    expect(screen.getByRole("status")).toHaveTextContent("Position synchronized. Black to move");
    expect(document.body.textContent).not.toContain("server-message-canary");
    expect(
      fetch.mock.calls.filter(([url]) => requestPath(url) === `/games/${GAME_ID}/moves`),
    ).toHaveLength(1);
  });

  it("keeps a rejected move locked until its authorized snapshot arrives", async () => {
    const read = Promise.withResolvers<Response>();
    mockApi({
      [`POST /games/${GAME_ID}/moves`]: () => errorResponse("ILLEGAL_MOVE", 422),
      [`GET /games/${GAME_ID}`]: () => read.promise,
    });
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: true });
    await start();
    const square = squaresOnBoard();
    await userEvent.click(square("e2"));
    await userEvent.click(square("e4"));
    await waitFor(() =>
      expect(screen.getByText("Checking the accepted position…")).toHaveAttribute(
        "aria-hidden",
        "false",
      ),
    );
    expect(screen.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
    expect(square("e2")).toHaveAccessibleName(/White pawn/);
    await act(async () => read.resolve(jsonResponse(snapshot())));
    await waitFor(() => expect(screen.getByRole("grid")).toHaveAttribute("aria-readonly", "false"));
    expect(screen.getByRole("status")).toHaveTextContent(
      "That move is no longer legal. Position synchronized.",
    );
  });

  it("blocks after an unreadable move response and retries with the identical command", async () => {
    let attempts = 0;
    const commands: string[] = [];
    mockApi({
      [`POST /games/${GAME_ID}/moves`]: (options) => {
        commands.push(requestBody(options));
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ state: "broken", message: "exception-canary" })
          : errorResponse("GAME_CONFLICT", 409, snapshot(["e2e4"]));
      },
      [`GET /games/${GAME_ID}`]: () => jsonResponse(snapshot()),
    });
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: true });
    await start();
    const square = squaresOnBoard();
    await userEvent.click(square("e2"));
    await userEvent.click(square("e4"));
    const retry = await screen.findByRole("button", { name: "Retry same move" });
    expect(screen.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
    expect(square("e2")).toHaveAccessibleName(/White pawn/);
    await userEvent.click(square("d2"));
    await userEvent.click(square("d4"));
    expect(commands).toHaveLength(1);
    await userEvent.click(retry);
    await waitFor(() => expect(square("e4")).toHaveAccessibleName(/White pawn/));
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(commands[0]);
    expect(document.body.textContent).not.toContain("exception-canary");
  });

  it("requires explicit action after session loss", async () => {
    const fetch = mockApi({
      [`POST /games/${GAME_ID}/moves`]: () => errorResponse("UNAUTHORIZED", 401),
    });
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: true });
    await start();
    const square = squaresOnBoard();
    await userEvent.click(square("e2"));
    await userEvent.click(square("e4"));
    const restart = await screen.findByRole("button", { name: "Start sandbox again" });
    expect(screen.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
    expect(screen.getByRole("grid")).toHaveAttribute("data-fen", snapshot().fen);
    expect(screen.queryByRole("region", { name: "Move history" })).not.toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => requestPath(url) === "/guest-session")).toHaveLength(
      1,
    );
    await userEvent.click(restart);
    await screen.findByRole("grid");
    expect(fetch.mock.calls.filter(([url]) => requestPath(url) === "/guest-session")).toHaveLength(
      2,
    );
  });

  it("shows a sandbox-specific unavailable state when readiness succeeds but creation returns 404", async () => {
    const fetch = mockApi({ "POST /sandbox/games": () => errorResponse("NOT_FOUND", 404) });
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: true });
    const button = await screen.findByRole("button", { name: "Start sandbox" });
    await waitFor(() => expect(button).toHaveAttribute("aria-disabled", "false"));
    await userEvent.click(button);
    const retry = await screen.findByRole("button", { name: "Retry sandbox" });
    expect(screen.getByText("Service ready")).toBeInTheDocument();
    expect(
      screen.getByText(/The development sandbox is unavailable/, { selector: "p" }),
    ).toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => requestPath(url) === "/sandbox/games")).toHaveLength(
      1,
    );
    await userEvent.click(retry);
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([url]) => requestPath(url) === "/sandbox/games"),
      ).toHaveLength(2),
    );
  });

  it("reports malformed readiness and retries without implicitly creating a guest", async () => {
    let checks = 0;
    const fetch = mockApi({
      "GET /ready": () => jsonResponse({ status: ++checks === 1 ? "bad" : "ready" }),
    });
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: true });
    const retry = await screen.findByRole("button", { name: "Retry connection" });
    expect(screen.getByRole("button", { name: "Start sandbox" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await userEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start sandbox" })).toHaveAttribute(
        "aria-disabled",
        "false",
      ),
    );
    expect(
      fetch.mock.calls.every(([url]) =>
        ["/ready", "/sandbox/games/unfinished"].includes(requestPath(url)),
      ),
    ).toBe(true);
  });

  it("completes Fool's Mate, locks movement and offers a new game", async () => {
    const played: string[] = [];
    mockApi({
      [`POST /games/${GAME_ID}/moves`]: (options) => {
        played.push(moveCommandSchema.parse(JSON.parse(requestBody(options))).move);
        return jsonResponse(snapshot(played));
      },
    });
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: true });
    await start();
    const square = squaresOnBoard();
    for (const move of FOOLS_MATE) {
      await userEvent.click(square(move.slice(0, 2)));
      await userEvent.click(square(move.slice(2, 4)));
      await waitFor(() =>
        expect(
          screen.getByText(played.length === 1 ? "1 ply" : played.length + " plies"),
        ).toBeInTheDocument(),
      );
    }
    expect(screen.getByRole("heading", { name: "Black wins by checkmate" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Black played Qh4#. Black wins. Checkmate. Result: 0-1.",
    );
    expect(screen.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
    expect(screen.getByRole("button", { name: "New game" })).toBeEnabled();
    const playArea = within(screen.getByRole("region", { name: "Play area" }));
    expect(playArea.getByRole("button", { name: "Copy PGN" })).toBeInTheDocument();
    expect(playArea.getByRole("button", { name: "Download PGN" })).toBeInTheDocument();
    await userEvent.click(playArea.getByRole("button", { name: "First" }));
    expect(screen.getByRole("grid")).toHaveAttribute("data-fen", snapshot().fen);
    expect(
      screen.getByRole("heading", { name: "Black wins by checkmate", level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Result: 0-1")).toBeInTheDocument();
    expect(screen.getByText("0–1")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Sandbox · Game complete · 2... Qh4#")).toBeInTheDocument();
  });

  it.each(["completed", "aborted"] as const)(
    "reopens a %s game without an unfinished-game notice or announcement",
    async (state) => {
      const terminal =
        state === "completed"
          ? snapshot(FOOLS_MATE)
          : snapshot(["e2e4"], { state, terminationReason: "aborted", legalMoves: [], version: 2 });
      window.history.replaceState(null, "", "/sandbox/games/" + terminal.gameId);
      const fetch = mockApi({
        [`GET /games/${terminal.gameId}`]: () => jsonResponse(terminal),
        [`GET /games/${terminal.gameId}/replay`]: () =>
          jsonResponse({ snapshot: terminal, initialFen: snapshot().fen }),
      });
      renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: true });
      await screen.findByRole("heading", {
        name: state === "completed" ? "Black wins by checkmate" : "Game stopped",
      });
      expect(screen.queryByText("Your current game is open.")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("Your game is open.");
      expect(screen.getByRole("status")).not.toHaveTextContent(/in progress|paused/);
      expect(screen.getByRole("grid")).toHaveAttribute("data-fen", terminal.fen);
      expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
    },
  );

  it.each(["replay", "Copy PGN", "Download PGN"])(
    "announces safe %s failures without moving focus",
    async (operation) => {
      const pending = Promise.withResolvers<Response>();
      const terminal = snapshot(FOOLS_MATE);
      window.history.replaceState(null, "", "/sandbox/games/" + terminal.gameId);
      mockApi({
        [`GET /games/${GAME_ID}`]: () => jsonResponse(terminal),
        [`GET /games/${GAME_ID}/${operation === "replay" ? "replay" : "pgn"}`]: () =>
          pending.promise,
      });
      renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: true });
      await screen.findByRole("heading", { name: "Black wins by checkmate" });
      const control = screen.getByRole("button", {
        name: operation === "replay" ? "Flip board" : operation,
      });
      act(() => control.focus());
      if (operation !== "replay") await userEvent.keyboard("{Enter}");

      await act(async () => pending.reject(new Error("private-exception-canary")));

      const message = "The service could not be reached. Check your connection and try again.";
      expect(screen.getByText(message, { selector: "p" })).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(message);
      expect(control).toHaveFocus();
      expect(document.body).not.toHaveTextContent("private-exception-canary");
    },
  );

  it("localizes square names and live announcements through typed resources with English fallback", async () => {
    const localization = createWebI18n();
    localization.addResourceBundle("fr", "translation", {
      players: { white: "Blanc", black: "Noir" },
      pieces: { white: { p: "pion blanc" } },
      game: { turn: "Au tour de {{color}}" },
      announcements: { move: "{{color}} joue {{move}}. {{status}}" },
    });
    await localization.changeLanguage("fr");
    mockApi();
    renderApp(
      { apiBaseUrl: "http://localhost:3001", sandboxEnabled: true },
      {
        i18n: localization,
      },
    );
    await start();
    const square = squaresOnBoard();
    expect(square("e2")).toHaveAccessibleName("e2: pion blanc.");
    await userEvent.click(square("e2"));
    await userEvent.click(square("e4"));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Blanc joue e4. Au tour de Noir"),
    );
    expect(screen.getByRole("heading", { name: "Sandbox" })).toBeInTheDocument();
  });

  it("keeps focus on Start while creation is pending, then lands on the board", async () => {
    const creation = Promise.withResolvers<Response>();
    const fetch = mockApi({ "POST /sandbox/games": () => creation.promise });
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: true });
    const user = userEvent.setup();
    const startButton = await screen.findByRole("button", { name: "Start sandbox" });
    await waitFor(() => expect(startButton).toHaveAttribute("aria-disabled", "false"));
    act(() => startButton.focus());
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("button", { name: "Starting sandbox…" })).toBe(startButton);
    expect(startButton).toHaveAttribute("aria-disabled", "true");
    expect(startButton).not.toBeDisabled();
    expect(startButton).toHaveFocus();
    await user.keyboard("{Enter} ");
    await user.click(startButton);
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([url]) => requestPath(url) === "/sandbox/games"),
      ).toHaveLength(1),
    );
    expect(fetch.mock.calls.filter(([url]) => requestPath(url) === "/guest-session")).toHaveLength(
      1,
    );
    await act(async () => creation.resolve(jsonResponse(snapshot(), 201)));
    await screen.findByRole("grid");
    expect(square("e2")).toHaveFocus();
  });

  it("leaves focus on a control the user moved to while creation was pending", async () => {
    const creation = Promise.withResolvers<Response>();
    mockApi({ "POST /sandbox/games": () => creation.promise });
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: true });
    const user = userEvent.setup();
    const startButton = await screen.findByRole("button", { name: "Start sandbox" });
    await waitFor(() => expect(startButton).toHaveAttribute("aria-disabled", "false"));
    act(() => startButton.focus());
    await user.keyboard("{Enter}");
    const navigation = screen.getByRole("link", { name: "Arena" });
    act(() => navigation.focus());
    await act(async () => creation.resolve(jsonResponse(snapshot(), 201)));
    await screen.findByRole("grid");
    expect(navigation).toHaveFocus();
  });

  it("lands on the board after New game replaces a finished game", async () => {
    const creation = Promise.withResolvers<Response>();
    const terminal = snapshot(FOOLS_MATE);
    window.history.replaceState(null, "", "/sandbox/games/" + terminal.gameId);
    mockApi({
      [`GET /games/${GAME_ID}`]: () => jsonResponse(terminal),
      "POST /sandbox/games": () => creation.promise,
    });
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: true });
    await screen.findByRole("heading", { name: "Black wins by checkmate" });
    const user = userEvent.setup();
    const newGame = screen.getByRole("button", { name: "New game" });
    act(() => newGame.focus());
    await user.keyboard("{Enter}");
    expect(newGame).toHaveAttribute("aria-disabled", "true");
    expect(newGame).toHaveFocus();
    await act(async () =>
      creation.resolve(jsonResponse(snapshot([], { gameId: OTHER_GAME_ID }), 201)),
    );
    await screen.findByRole("heading", { name: "White to move" });
    expect(screen.queryByRole("button", { name: "New game" })).not.toBeInTheDocument();
    expect(square("e2")).toHaveFocus();
  });

  it("does not move focus when an unfinished game is recovered on load", async () => {
    mockApi({
      "GET /sandbox/games/unfinished": () => jsonResponse({ snapshot: snapshot(["e2e4"]) }),
      [`POST /games/${GAME_ID}/lifecycle`]: () =>
        jsonResponse(snapshot(["e2e4"], { state: "paused", legalMoves: [], version: 2 })),
    });
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: true });
    await screen.findByRole("heading", { name: /^Game paused ·/ });
    expect(screen.getByRole("grid").contains(document.activeElement)).toBe(false);
  });
});
