import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/App";
import { GAME_ID, jsonResponse, requestBody, requestPath } from "../test/fixtures";
import { createHttpMock } from "../test/http";
import { renderLocalized } from "../test/render";

const session = {
  user: { id: GAME_ID, email: "private@example.com", emailVerified: true },
  session: { expiresAt: "2027-10-01T00:00:00.000Z" },
};
const profile = {
  username: "Player",
  completed: true,
  avatar: { source: "initials", initials: "PL" },
};
afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("account presentation", () => {
  it.each(["focus", "profile-changed"])(
    "uses the refreshed username in an untouched form after a %s notification",
    async (notification) => {
      window.history.replaceState(null, "", "/account");
      let current = profile;
      const http = createHttpMock({
        "GET /api/auth/get-session": () => jsonResponse(session),
        "GET /profile": () => jsonResponse(current),
        "POST /profile": () => jsonResponse(current),
      });
      vi.stubGlobal("fetch", http.fetch);
      renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
      await screen.findByRole("heading", { name: "Your profile" });
      expect(screen.getByLabelText("Username")).toHaveValue("Player");
      current = { ...profile, username: "Renamed" };
      const channel = new BroadcastChannel("neurochess.identity");
      try {
        await act(async () => {
          if (notification === "profile-changed") channel.postMessage(notification);
          else fireEvent(window, new Event("focus"));
        });
        await screen.findByRole("link", { name: /Renamed/ });
        expect(screen.getByLabelText("Username")).toHaveValue("Renamed");
        await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
        await screen.findByText("Profile saved.");
        const saved = http.fetch.mock.calls.find(
          ([url, options]) => requestPath(url) === "/profile" && options?.method === "POST",
        );
        expect(requestBody(saved?.[1])).toBe(JSON.stringify({ username: "Renamed" }));
        http.assertNoUnexpectedRequests();
      } finally {
        channel.close();
      }
    },
  );
  it.each(["focus", "profile-changed"])(
    "preserves and submits a username draft after a %s notification",
    async (notification) => {
      window.history.replaceState(null, "", "/account");
      let current = profile;
      const http = createHttpMock({
        "GET /api/auth/get-session": () => jsonResponse(session),
        "GET /profile": () => jsonResponse(current),
        "POST /profile": () => {
          current = { ...profile, username: "LocalDraft" };
          return jsonResponse(current);
        },
      });
      vi.stubGlobal("fetch", http.fetch);
      renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
      await screen.findByRole("heading", { name: "Your profile" });
      await userEvent.clear(screen.getByLabelText("Username"));
      await userEvent.type(screen.getByLabelText("Username"), " LocalDraft ");

      current = { ...profile, username: "Renamed" };
      const channel = new BroadcastChannel("neurochess.identity");
      try {
        await act(async () => {
          if (notification === "profile-changed") channel.postMessage(notification);
          else fireEvent(window, new Event("focus"));
        });
        await screen.findByRole("link", { name: /Renamed/ });
        expect(screen.getByLabelText("Username")).toHaveValue(" LocalDraft ");
        expect(screen.getByLabelText("Username")).toHaveFocus();
        await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
        await screen.findByText("Profile saved.");
        const saved = http.fetch.mock.calls.find(
          ([url, options]) => requestPath(url) === "/profile" && options?.method === "POST",
        );
        expect(requestBody(saved?.[1])).toBe(JSON.stringify({ username: "LocalDraft" }));
        expect(screen.getByLabelText("Username")).toHaveValue("LocalDraft");

        current = { ...profile, username: "RenamedAgain" };
        await act(async () => fireEvent(window, new Event("focus")));
        await screen.findByRole("link", { name: /RenamedAgain/ });
        expect(screen.getByLabelText("Username")).toHaveValue("RenamedAgain");
        http.assertNoUnexpectedRequests();
      } finally {
        channel.close();
      }
    },
  );
  it("preserves a username draft when a refresh only changes the avatar", async () => {
    window.history.replaceState(null, "", "/account");
    let removed = false;
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () =>
        jsonResponse({
          ...profile,
          avatar: removed
            ? profile.avatar
            : {
                ...profile.avatar,
                source: "github",
                url: "https://avatars.githubusercontent.com/u/123",
              },
        }),
    });
    vi.stubGlobal("fetch", http.fetch);
    renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
    await screen.findByRole("button", { name: "Remove avatar" });
    await userEvent.clear(screen.getByLabelText("Username"));
    await userEvent.type(screen.getByLabelText("Username"), "LocalDraft");
    removed = true;
    await act(async () => fireEvent(window, new Event("focus")));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Remove avatar" })).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Username")).toHaveValue("LocalDraft");
    http.assertNoUnexpectedRequests();
  });
  it.each(["failed save", "avatar removal"])(
    "keeps the username draft after %s and a background rename",
    async (action) => {
      window.history.replaceState(null, "", "/account");
      let renamed = false;
      let removed = false;
      const http = createHttpMock({
        "GET /api/auth/get-session": () => jsonResponse(session),
        "GET /profile": () =>
          jsonResponse({
            ...profile,
            username: renamed ? "Renamed" : "Player",
            avatar: removed
              ? profile.avatar
              : {
                  ...profile.avatar,
                  source: "github",
                  url: "https://avatars.githubusercontent.com/u/123",
                },
          }),
        "POST /profile": () => {
          if (action === "failed save") {
            return jsonResponse(
              { code: "PROFILE_USERNAME_TAKEN", message: "conflict", requestId: "test" },
              409,
            );
          }
          removed = true;
          return jsonResponse(profile);
        },
      });
      vi.stubGlobal("fetch", http.fetch);
      renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
      await screen.findByRole("heading", { name: "Your profile" });
      await userEvent.clear(screen.getByLabelText("Username"));
      await userEvent.type(screen.getByLabelText("Username"), "LocalDraft");
      await userEvent.click(
        screen.getByRole("button", {
          name: action === "failed save" ? "Save profile" : "Remove avatar",
        }),
      );
      if (action === "failed save") await screen.findByRole("alert");
      else await screen.findByText("Profile saved.");

      renamed = true;
      await act(async () => fireEvent(window, new Event("focus")));
      await screen.findByRole("link", { name: /Renamed/ });
      expect(screen.getByLabelText("Username")).toHaveValue("LocalDraft");
      http.assertNoUnexpectedRequests();
    },
  );
  it("discards the username draft when the account changes", async () => {
    window.history.replaceState(null, "", "/account");
    let switched = false;
    const http = createHttpMock({
      "GET /api/auth/get-session": () =>
        jsonResponse(
          switched
            ? { ...session, user: { ...session.user, id: "20000000-0000-4000-8000-000000000002" } }
            : session,
        ),
      "GET /profile": () =>
        jsonResponse(switched ? { ...profile, username: "OtherPlayer" } : profile),
    });
    vi.stubGlobal("fetch", http.fetch);
    renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
    await screen.findByRole("heading", { name: "Your profile" });
    await userEvent.clear(screen.getByLabelText("Username"));
    await userEvent.type(screen.getByLabelText("Username"), "LocalDraft");

    switched = true;
    await act(async () => fireEvent(window, new Event("focus")));
    await screen.findByRole("link", { name: /OtherPlayer/ });
    expect(screen.getByLabelText("Username")).toHaveValue("OtherPlayer");
    http.assertNoUnexpectedRequests();
  });
  it("accepts a fresh form submission after BFCache restore without retaining the previous password", async () => {
    window.history.replaceState(null, "", "/auth/sign-up");
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      "POST /api/auth/sign-up/email": () =>
        jsonResponse({ status: "accepted", message: "receipt" }),
    });
    vi.stubGlobal("fetch", http.fetch);
    renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
    await userEvent.type(screen.getByLabelText("Password", { exact: true }), "old-password-canary");
    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    expect(screen.getByLabelText("Password", { exact: true })).toHaveValue("");
    await userEvent.type(screen.getByLabelText("Email"), "player@example.com");
    await userEvent.type(
      screen.getByLabelText("Password", { exact: true }),
      "new-password-fixture",
    );
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByText(/Request received/);
    http.assertNoUnexpectedRequests();
  });
  it("keeps sign-out failures visible so the user can explicitly retry", async () => {
    window.history.replaceState(null, "", "/");
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse(profile),
      "GET /games/unfinished": () => jsonResponse({ game: null }),
      "POST /api/auth/sign-out": () =>
        jsonResponse(
          { code: "AUTH_UNAVAILABLE", message: "unsafe-canary", requestId: "test" },
          503,
        ),
    });
    vi.stubGlobal("fetch", http.fetch);
    renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not complete/);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    http.assertNoUnexpectedRequests();
  });
  it("accepts pasted passwords, acknowledges registration generically and explains guest separation", async () => {
    window.history.replaceState(null, "", "/auth/sign-up");
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      "POST /api/auth/sign-up/email": () =>
        jsonResponse({ status: "accepted", message: "untrusted-canary" }),
    });
    vi.stubGlobal("fetch", http.fetch);
    renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
    await screen.findByRole("heading", { name: "Create an account" });
    expect(screen.getByText(/Guest games stay separate/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "player@example.com");
    await user.click(screen.getByLabelText("Password", { exact: true }));
    await user.paste("a pasted password 🌙");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(screen.getByLabelText("Password", { exact: true })).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Password", { exact: true })).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    await user.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByText(/Request received/);
    expect(screen.getByLabelText("Password", { exact: true })).toHaveValue("");
    expect(screen.getByLabelText("Password", { exact: true })).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Show password" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(document.body).not.toHaveTextContent("untrusted-canary");
    http.assertNoUnexpectedRequests();
  });
  it("requires username onboarding before account setup and handles duplicate names safely", async () => {
    window.history.replaceState(null, "", "/");
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () =>
        jsonResponse({
          ...profile,
          username: null,
          completed: false,
          avatar: { source: "initials", initials: "?" },
        }),
      "POST /profile/onboarding": () =>
        jsonResponse(
          { code: "PROFILE_USERNAME_TAKEN", message: "unsafe-response", requestId: "test" },
          409,
        ),
    });
    vi.stubGlobal("fetch", http.fetch);
    renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
    await screen.findByRole("heading", { name: "Choose your username" });
    await userEvent.type(screen.getByLabelText("Username"), "Player");
    await userEvent.click(screen.getByRole("button", { name: "Finish profile" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(/already in use/);
    expect(http.fetch.mock.calls.some(([url]) => requestPath(url).startsWith("/games"))).toBe(
      false,
    );
    http.assertNoUnexpectedRequests();
  });
  it("removes account UI and keys after another tab changes the session, fencing a delayed discovery", async () => {
    window.history.replaceState(null, "", "/");
    let current: typeof session | null = session;
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(current),
      "GET /profile": () => jsonResponse(profile),
      "GET /games/unfinished": () => jsonResponse({ game: null }),
    });
    vi.stubGlobal("fetch", http.fetch);
    renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
    await screen.findByRole("heading", { name: "Set up a game" });
    expect(screen.getByRole("link", { name: /Player/ })).toBeInTheDocument();
    current = null;
    await act(async () => fireEvent(window, new Event("focus")));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Set up a game" })).not.toBeInTheDocument(),
    );
    await screen.findByRole("heading", { name: "Sign in to continue" });
    expect(screen.queryByText("Player")).not.toBeInTheDocument();
    expect(http.fetch.mock.calls.some(([url]) => requestPath(url) === "/guest-session")).toBe(
      false,
    );
    http.assertNoUnexpectedRequests();
  });
});
