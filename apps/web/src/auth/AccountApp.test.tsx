import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/App";
import { jsonResponse, requestBody, requestPath } from "../test/fixtures";
import { createHttpMock } from "../test/http";
import { renderLocalized } from "../test/render";

import { consumeAuthEntry } from "./navigation";

const profile = (username: string) => ({
  username,
  onboardingRequired: false,
  avatar: { source: "initials", initials: username.slice(0, 2).toUpperCase() },
  providerAvatar: null,
});
const session = (id: string) => ({
  user: { id, email: id + "@example.test", emailVerified: true },
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
});
let http: ReturnType<typeof createHttpMock>;
beforeEach(() => localStorage.clear());
afterEach(() => {
  http.assertNoUnexpectedRequests();
  localStorage.clear();
});

describe("account forms and identity boundary", () => {
  it("confirms account deletion separately, focuses Cancel and clears private state while submitting only once", async () => {
    window.history.replaceState(null, "", "/account");
    const result = Promise.withResolvers<Response>();
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse({ session: session("Alice") }),
      "GET /api/profile": () => jsonResponse(profile("Alice")),
      "GET /api/auth/methods": () => jsonResponse({ email: true, providers: [] }),
      "GET /api/credentials": () => jsonResponse({ credentials: [], nextCursor: null }),
      "POST /api/auth/delete-account": () => result.promise,
    });
    vi.stubGlobal("fetch", http.fetch);
    renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Delete account" }));
    const dialog = within(screen.getByRole("dialog", { name: "Delete your account?" }));
    expect(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(dialog.getByText(/including active and paused games/)).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete account" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Delete account" }));
    await user.dblClick(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete account" }),
    );
    expect(await screen.findByText("Deleting your account…")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Alice" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete account" })).not.toBeInTheDocument();
    const calls = http.fetch.mock.calls.filter(([url]) =>
      requestPath(url).endsWith("/delete-account"),
    );
    expect(calls).toHaveLength(1);
    expect(JSON.parse(requestBody(calls[0]![1]))).toEqual({
      confirm: true,
      expectedUserId: "Alice",
    });
    await act(async () => result.resolve(jsonResponse({ status: true })));
    expect(await screen.findByText(/Your account and associated data were deleted/)).toBeVisible();
    expect(window.location.pathname).toBe("/");
    expect(document.body).not.toHaveTextContent("Alice");
  });

  it("does not claim deletion after a lost acknowledgement and requires checking the session before another confirmation", async () => {
    window.history.replaceState(null, "", "/account");
    http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse({ session: session("Alice") }),
      "GET /api/profile": () => jsonResponse(profile("Alice")),
      "GET /api/auth/methods": () => jsonResponse({ email: true, providers: [] }),
      "GET /api/credentials": () => jsonResponse({ credentials: [], nextCursor: null }),
      "POST /api/auth/delete-account": () => Promise.reject(new TypeError("private-network-error")),
    });
    vi.stubGlobal("fetch", http.fetch);
    renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete account" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete account" }),
    );
    expect(
      await screen.findByText(/We could not confirm whether your account was deleted/),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent("private-network-error");
    expect(
      screen.queryByText(/Your account and associated data were deleted/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete account" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Check session/ }));
    expect(await screen.findByRole("button", { name: "Delete account" })).toBeVisible();
  });

  it("posts a consumed verification token once under Strict Mode and keeps it out of navigation", async () => {
    window.history.replaceState(null, "", "/auth/verify-email#token=private-verification");
    const entry = consumeAuthEntry();
    const verified = Promise.withResolvers<Response>();
    http = createHttpMock({
      "GET /api/credentials": () => jsonResponse({ credentials: [], nextCursor: null }),
      "GET /api/auth/get-session": () => jsonResponse({ session: null }),
      "GET /api/auth/methods": () => jsonResponse({ email: true, providers: [] }),
      "POST /api/auth/verify-email": () => verified.promise,
    });
    vi.stubGlobal("fetch", http.fetch);
    renderLocalized(
      <StrictMode>
        <App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} authEntry={entry} />
      </StrictMode>,
    );
    const button = await screen.findByRole("button", { name: "Verify email" });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(
      http.fetch.mock.calls.filter(([url]) => requestPath(url).endsWith("/verify-email")),
    ).toHaveLength(1);
    await act(async () => verified.resolve(jsonResponse({ status: true })));
    expect(await screen.findByText("Email verified. You can now sign in.")).toBeVisible();
    expect(
      window.location.href + JSON.stringify(localStorage) + JSON.stringify(sessionStorage),
    ).not.toContain("private-verification");
  });
  it("accepts password paste, retains the email on failure and never displays upstream diagnostics", async () => {
    window.history.replaceState(null, "", "/auth/sign-in");
    http = createHttpMock({
      "GET /api/credentials": () => jsonResponse({ credentials: [], nextCursor: null }),
      "GET /api/auth/get-session": () => jsonResponse({ session: null }),
      "GET /api/auth/methods": () => jsonResponse({ email: true, providers: [] }),
      "POST /api/auth/sign-in/email": () =>
        jsonResponse(
          { code: "AUTH_INVALID_CREDENTIALS", message: "raw-secret-error", requestId: "test" },
          401,
        ),
    });
    vi.stubGlobal("fetch", http.fetch);
    renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "alice@example.test");
    await user.click(screen.getByLabelText("Password"));
    await user.paste(" pasted password with spaces ");
    await user.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The email or password is incorrect.",
    );
    expect(screen.getByLabelText("Email")).toHaveValue("alice@example.test");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    await user.type(screen.getByLabelText("Password"), "replacement password");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(document.body).not.toHaveTextContent("raw-secret-error");
    const post = http.fetch.mock.calls.find(([url]) => requestPath(url).endsWith("/sign-in/email"));
    expect(JSON.parse(requestBody(post?.[1]))).toMatchObject({
      password: " pasted password with spaces ",
    });
  });
  it("clears setup keys and discards delayed old-account discovery after a tab switches accounts", async () => {
    window.history.replaceState(null, "", "/");
    let id = "Alice";
    const delayed = Promise.withResolvers<Response>();
    let discoverySignal: AbortSignal | null | undefined;
    http = createHttpMock({
      "GET /api/credentials": () => jsonResponse({ credentials: [], nextCursor: null }),
      "GET /api/auth/get-session": () => jsonResponse({ session: session(id) }),
      "GET /api/profile": () => jsonResponse(profile(id)),
      "GET /games/unfinished": () => jsonResponse({ game: null }),
      "POST /providers/models": (options) => {
        discoverySignal = options?.signal;
        return delayed.promise;
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
    const white = within(await screen.findByRole("group", { name: "White" }));
    await userEvent.type(white.getByLabelText("API key"), "page-owned-key");
    await userEvent.click(white.getByRole("button", { name: "Load models" }));
    await waitFor(() => expect(discoverySignal).toBeDefined());
    id = "Bob";
    await act(async () =>
      window.dispatchEvent(
        new StorageEvent("storage", { key: "neurochess.identity-change", newValue: "switch" }),
      ),
    );
    await screen.findByRole("link", { name: "Bob" });
    expect(discoverySignal?.aborted).toBe(true);
    await act(async () => delayed.resolve(jsonResponse({ ok: true, models: [] })));
    await waitFor(() => expect(screen.getAllByLabelText("API key")[0]).toHaveValue(""));
    expect(screen.queryByRole("link", { name: "Alice" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("page-owned-key");
    expect(http.fetch.mock.calls.some(([url]) => requestPath(url).endsWith("/guest-session"))).toBe(
      false,
    );
  });
});
