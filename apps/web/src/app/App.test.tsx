import { moveCommandSchema } from "@neurochess/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { createWebI18n } from "../i18n";
import { errorResponse, FOOLS_MATE, GAME_ID, jsonResponse, snapshot } from "../test/fixtures";
import { square } from "../test/queries";
import { renderLocalized } from "../test/render";

type Route = (
  path: string,
  options: RequestInit | undefined,
) => Response | Promise<Response> | undefined;

function mockApi(route: Route = () => undefined) {
  const fetch = vi.fn<typeof globalThis.fetch>((input, options) => {
    const path = new URL(String(input)).pathname;
    const response = route(path, options);
    if (response) return Promise.resolve(response);
    if (path === "/ready") return Promise.resolve(jsonResponse({ status: "ready" }));
    if (path === "/sandbox/games/unfinished")
      return Promise.resolve(jsonResponse({ snapshot: null }));
    if (path.endsWith("/replay"))
      return Promise.resolve(
        jsonResponse({ snapshot: snapshot(FOOLS_MATE), initialFen: snapshot().fen }),
      );
    if (path === "/guest-session") return Promise.resolve(jsonResponse({ status: "ready" }));
    if (path === "/sandbox/games") return Promise.resolve(jsonResponse(snapshot(), 201));
    if (path.endsWith("/moves")) return Promise.resolve(jsonResponse(snapshot(["e2e4"])));
    return Promise.resolve(jsonResponse(snapshot()));
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function start() {
  const button = screen.getByRole("button", { name: "Start sandbox" });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
  await screen.findByRole("grid", { name: "Chessboard" });
}

describe("localized sandbox application", () => {
  beforeEach(() => window.history.replaceState(null, "", "/"));
  it("boots only on action under Strict Mode and orders cookie bootstrap before creation", async () => {
    const bootstrap = Promise.withResolvers<Response>();
    const fetch = mockApi((path) => (path === "/guest-session" ? bootstrap.promise : undefined));
    renderLocalized(
      <StrictMode>
        <App apiBaseUrl="http://localhost:3001" />
      </StrictMode>,
    );
    expect(screen.getByRole("heading", { name: "Development sandbox" })).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Start sandbox" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(
      fetch.mock.calls.every(([url]) =>
        ["/ready", "/sandbox/games/unfinished"].some((path) => String(url).endsWith(path)),
      ),
    ).toBe(true);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/guest-session"))).toHaveLength(
      1,
    );
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/sandbox/games"))).toHaveLength(
      0,
    );
    await act(async () => bootstrap.resolve(jsonResponse({ status: "ready" })));
    await screen.findByRole("grid");
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/sandbox/games"))).toHaveLength(
      1,
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("keeps the accepted board, turn and history while submitting and announces confirmation once", async () => {
    const pending = Promise.withResolvers<Response>();
    mockApi((path) => (path.endsWith("/moves") ? pending.promise : undefined));
    renderLocalized(<App apiBaseUrl="http://localhost:3001" />);
    await start();
    const live = screen.getByRole("status");
    const announcements: string[] = [];
    const observer = new MutationObserver(() => announcements.push(live.textContent ?? ""));
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
    mockApi((path) =>
      path.endsWith("/lifecycle") ? (++requests === 1 ? pause.promise : resume.promise) : undefined,
    );
    renderLocalized(<App apiBaseUrl="http://localhost:3001" />);
    await start();
    const user = userEvent.setup();
    const control = screen.getByRole("button", { name: "Pause" });
    act(() => control.focus());

    await user.keyboard("{Enter}");
    expect(control).toHaveFocus();
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(control).not.toBeDisabled();
    await act(async () =>
      pause.resolve(jsonResponse(snapshot([], { state: "paused", legalMoves: [], version: 1 }))),
    );
    expect(await screen.findByRole("button", { name: "Resume" })).toBe(control);
    expect(control).not.toHaveAttribute("aria-disabled", "true");
    expect(control).toHaveFocus();

    await user.keyboard(" ");
    expect(control).toHaveFocus();
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(control).not.toBeDisabled();
    await act(async () => resume.resolve(jsonResponse(snapshot([], { version: 2 }))));
    expect(await screen.findByRole("button", { name: "Pause" })).toBe(control);
    expect(control).not.toHaveAttribute("aria-disabled", "true");
    expect(control).toHaveFocus();
    expect(requests).toBe(2);
  });

  it("blocks repeat lifecycle activation and destructive dialogs while a command is pending", async () => {
    const pending = Promise.withResolvers<Response>();
    const fetch = mockApi((path) => (path.endsWith("/lifecycle") ? pending.promise : undefined));
    renderLocalized(<App apiBaseUrl="http://localhost:3001" />);
    await start();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Pause" }));

    for (const name of ["Pause", "Abort game", "Resign White", "Resign Black"]) {
      const control = screen.getByRole("button", { name });
      expect(control).toHaveAttribute("aria-disabled", "true");
      await user.click(control);
      await user.keyboard("{Enter} ");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    }
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/lifecycle"))).toHaveLength(1);
    await act(async () =>
      pending.resolve(jsonResponse(snapshot([], { state: "paused", legalMoves: [], version: 1 }))),
    );
    await screen.findByRole("button", { name: "Resume" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not steal board focus when a delayed Pause or Resume completes", async () => {
    const pause = Promise.withResolvers<Response>();
    const resume = Promise.withResolvers<Response>();
    let requests = 0;
    mockApi((path) =>
      path.endsWith("/lifecycle") ? (++requests === 1 ? pause.promise : resume.promise) : undefined,
    );
    renderLocalized(<App apiBaseUrl="http://localhost:3001" />);
    await start();

    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    await userEvent.click(square("e2"));
    expect(square("e2")).toHaveFocus();
    await act(async () =>
      pause.resolve(jsonResponse(snapshot([], { state: "paused", legalMoves: [], version: 1 }))),
    );
    await screen.findByRole("button", { name: "Resume" });
    expect(square("e2")).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    await userEvent.click(square("e2"));
    expect(square("e2")).toHaveFocus();
    await act(async () => resume.resolve(jsonResponse(snapshot([], { version: 2 }))));
    await screen.findByRole("button", { name: "Pause" });
    expect(square("e2")).toHaveFocus();
  });

  it("adopts a conflict without replay or server prose and clears stale selection", async () => {
    const current = snapshot(["d2d4"]);
    const fetch = mockApi((path) =>
      path.endsWith("/moves") ? errorResponse("GAME_CONFLICT", 409, current) : undefined,
    );
    renderLocalized(<App apiBaseUrl="http://localhost:3001" />);
    await start();
    await userEvent.click(square("e2"));
    await userEvent.click(square("e4"));
    await waitFor(() => expect(square("d4")).toHaveAccessibleName(/White pawn/));
    expect(square("e2")).not.toHaveAttribute("data-selected");
    expect(screen.getByRole("status")).toHaveTextContent("Position synchronized. Black to move");
    expect(document.body.textContent).not.toContain("server-message-canary");
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/moves"))).toHaveLength(1);
  });

  it("keeps a rejected move locked until its authorized snapshot arrives", async () => {
    const read = Promise.withResolvers<Response>();
    mockApi((path) =>
      path.endsWith("/moves")
        ? errorResponse("ILLEGAL_MOVE", 422)
        : path === "/games/" + GAME_ID
          ? read.promise
          : undefined,
    );
    renderLocalized(<App apiBaseUrl="http://localhost:3001" />);
    await start();
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
    mockApi((path, options) => {
      if (!path.endsWith("/moves")) return undefined;
      commands.push(String(options?.body));
      attempts += 1;
      return attempts === 1
        ? jsonResponse({ state: "broken", message: "exception-canary" })
        : errorResponse("GAME_CONFLICT", 409, snapshot(["e2e4"]));
    });
    renderLocalized(<App apiBaseUrl="http://localhost:3001" />);
    await start();
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
    const fetch = mockApi((path) =>
      path.endsWith("/moves") ? errorResponse("UNAUTHORIZED", 401) : undefined,
    );
    renderLocalized(<App apiBaseUrl="http://localhost:3001" />);
    await start();
    await userEvent.click(square("e2"));
    await userEvent.click(square("e4"));
    const restart = await screen.findByRole("button", { name: "Start sandbox again" });
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/guest-session"))).toHaveLength(
      1,
    );
    await userEvent.click(restart);
    await screen.findByRole("grid");
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/guest-session"))).toHaveLength(
      2,
    );
  });

  it("shows a sandbox-specific unavailable state when readiness succeeds but creation returns 404", async () => {
    const fetch = mockApi((path) =>
      path === "/sandbox/games" ? errorResponse("NOT_FOUND", 404) : undefined,
    );
    renderLocalized(<App apiBaseUrl="http://localhost:3001" />);
    const button = screen.getByRole("button", { name: "Start sandbox" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    const retry = await screen.findByRole("button", { name: "Retry sandbox" });
    expect(screen.getByText("Service ready")).toBeInTheDocument();
    expect(
      screen.getByText(/The development sandbox is unavailable/, { selector: "p" }),
    ).toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/sandbox/games"))).toHaveLength(
      1,
    );
    await userEvent.click(retry);
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([url]) => String(url).endsWith("/sandbox/games")),
      ).toHaveLength(2),
    );
  });

  it("reports malformed readiness and retries without implicitly creating a guest", async () => {
    let checks = 0;
    const fetch = mockApi((path) => {
      if (path !== "/ready") return undefined;
      return jsonResponse({ status: ++checks === 1 ? "bad" : "ready" });
    });
    renderLocalized(<App apiBaseUrl="http://localhost:3001" />);
    const retry = await screen.findByRole("button", { name: "Retry connection" });
    expect(screen.getByRole("button", { name: "Start sandbox" })).toBeDisabled();
    await userEvent.click(retry);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start sandbox" })).toBeEnabled(),
    );
    expect(
      fetch.mock.calls.every(([url]) =>
        ["/ready", "/sandbox/games/unfinished"].some((path) => String(url).endsWith(path)),
      ),
    ).toBe(true);
  });

  it("completes Fool's Mate, locks movement and offers a new game", async () => {
    const played: string[] = [];
    mockApi((path, options) => {
      if (!path.endsWith("/moves")) return undefined;
      played.push(moveCommandSchema.parse(JSON.parse(String(options?.body))).move);
      return jsonResponse(snapshot(played));
    });
    renderLocalized(<App apiBaseUrl="http://localhost:3001" />);
    await start();
    for (const move of FOOLS_MATE) {
      await userEvent.click(square(move.slice(0, 2)));
      await userEvent.click(square(move.slice(2, 4)));
      await waitFor(() =>
        expect(
          screen.getByText(played.length === 1 ? "1 ply" : played.length + " plies"),
        ).toBeInTheDocument(),
      );
    }
    expect(screen.getByRole("heading", { name: "Black wins" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Black played Qh4#. Black wins. Checkmate. Result: 0-1.",
    );
    expect(screen.getByRole("grid")).toHaveAttribute("aria-readonly", "true");
    expect(screen.getByRole("button", { name: "New game" })).toBeEnabled();
  });

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
    renderLocalized(<App apiBaseUrl="http://localhost:3001" />, { i18n: localization });
    await start();
    expect(square("e2")).toHaveAccessibleName("e2: pion blanc.");
    await userEvent.click(square("e2"));
    await userEvent.click(square("e4"));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Blanc joue e4. Au tour de Noir"),
    );
    expect(screen.getByRole("heading", { name: "Development sandbox" })).toBeInTheDocument();
  });
});
