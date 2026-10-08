import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ScopedRouteData } from "../routing/route-runtime";
import {
  GAME_ID,
  jsonResponse,
  OTHER_GAME_ID,
  requestBody,
  requestPath,
  snapshot,
} from "../test/fixtures";
import { createHttpMock } from "../test/http";
import { renderApp } from "../test/render";

import { consumeAuthEntry } from "./auth-entry";

const options = { apiBaseUrl: "http://localhost:3001", sandboxEnabled: false };
const session = {
  user: { id: OTHER_GAME_ID, email: "private@example.com", emailVerified: true },
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

describe("identity changes across router data", () => {
  it("publishes completed onboarding before its guard unmounts the form", async () => {
    let completed = false;
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () =>
        jsonResponse(completed ? profile : { ...profile, completed: false, username: null }),
      "POST /profile/onboarding": () => {
        completed = true;
        return jsonResponse(profile);
      },
      "GET /games/unfinished": () => jsonResponse({ game: null }),
      "GET /credentials": () => jsonResponse({ credentials: [] }),
    });
    vi.stubGlobal("fetch", http.fetch);
    const channel = new BroadcastChannel("neurochess.identity");
    const messages: unknown[] = [];
    channel.onmessage = (event: MessageEvent<unknown>) => {
      messages.push(event.data);
    };
    try {
      renderApp(options, { initialEntries: ["/"], strict: true });
      await userEvent.type(await screen.findByLabelText("Username"), "Player");
      await userEvent.click(screen.getByRole("button", { name: "Finish profile" }));
      await screen.findByRole("heading", { name: "Set up a game" });
      await waitFor(() => expect(messages).toContain("profile-changed"));
      http.assertNoUnexpectedRequests();
    } finally {
      channel.close();
    }
  });
  it("defers canceled sign-in reconciliation while outside the public branch", async () => {
    const pending = Promise.withResolvers<Response>();
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      "GET /games/unfinished": () => jsonResponse({ game: null }),
      "POST /api/auth/sign-in/email": () => pending.promise,
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: ["/auth/sign-in"] });
    await userEvent.type(await screen.findByLabelText("Email"), "player@example.com");
    await userEvent.type(
      screen.getByLabelText("Password", { exact: true }),
      "password-departure-canary",
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(
        http.fetch.mock.calls.some(([url]) => requestPath(url) === "/api/auth/sign-in/email"),
      ).toBe(true),
    );
    const reads = () =>
      http.fetch.mock.calls.filter(([url]) => requestPath(url) === "/api/auth/get-session").length;
    const before = reads();
    await act(() => router.navigate("/missing"));
    expect(reads()).toBe(before);
    await act(async () => pending.resolve(jsonResponse({ success: true })));
    expect(router.state.location.pathname).toBe("/missing");
    expect(reads()).toBe(before);
    await act(() => router.navigate("/"));
    await screen.findByRole("heading", { name: "Sign in to continue" });
    expect(reads()).toBeGreaterThan(before);
    http.assertNoUnexpectedRequests();
  });

  it.each([
    { path: "/auth/sign-up", endpoint: "/api/auth/sign-up/email", button: "Create account" },
    { path: "/auth/sign-in", endpoint: "/api/auth/sign-in/email", button: "Sign in" },
    { path: "/auth/sign-in", endpoint: "/api/auth/sign-in/social", button: "Continue with Google" },
  ] as const)(
    "clears a pending $button form on external identity change and fences its late acknowledgement",
    async ({ path, endpoint, button }) => {
      const pending = Promise.withResolvers<Response>();
      const http = createHttpMock({
        "GET /api/auth/get-session": () => jsonResponse(null),
        [`POST ${endpoint}`]: () => pending.promise,
      });
      vi.stubGlobal("fetch", http.fetch);
      const { router } = renderApp(options, { initialEntries: [path] });
      await userEvent.type(await screen.findByLabelText("Email"), "player@example.com");
      await userEvent.type(
        screen.getByLabelText("Password", { exact: true }),
        "password-fetcher-canary",
      );
      await userEvent.click(screen.getByRole("button", { name: button }));
      await waitFor(() =>
        expect(
          [...router.state.fetchers.values()].some((fetcher) => fetcher.state === "submitting"),
        ).toBe(true),
      );
      await waitFor(() =>
        expect(http.fetch.mock.calls.some(([url]) => requestPath(url) === endpoint)).toBe(true),
      );
      const channel = new BroadcastChannel("neurochess.identity");
      try {
        await act(async () => {
          channel.postMessage("changed");
        });
        await waitFor(() =>
          expect(
            [...router.state.fetchers.values()].every((fetcher) => fetcher.state === "idle"),
          ).toBe(true),
        );
        expect(screen.getByLabelText("Password", { exact: true })).toHaveValue("");
        expect(screen.getByLabelText("Email")).toHaveValue("");
        expect(JSON.stringify([...router.state.fetchers])).not.toContain("password-fetcher-canary");
        await act(async () =>
          pending.resolve(
            jsonResponse(
              button === "Continue with Google"
                ? { url: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture" }
                : button === "Sign in"
                  ? { success: true }
                  : { status: "accepted", message: "receipt" },
            ),
          ),
        );
        expect(screen.queryByText(/Request received/)).not.toBeInTheDocument();
        expect(router.state.location.pathname).toBe(path);
      } finally {
        channel.close();
      }
      http.assertNoUnexpectedRequests();
    },
  );

  it("clears the actual loader, action and fetcher result objects before a replacement session read settles", async () => {
    let delayed = false;
    const pending = Promise.withResolvers<void>();
    const http = createHttpMock({
      "GET /api/auth/get-session": async () => {
        if (delayed) await pending.promise;
        return jsonResponse(null);
      },
      "POST /api/auth/sign-up/email": () =>
        jsonResponse({ status: "accepted", message: "receipt" }),
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, { initialEntries: ["/auth/sign-up"] });
    await screen.findByLabelText("Email");
    const submission = new FormData();
    submission.set("intent", "sign-up");
    submission.set("email", "player@example.com");
    submission.set("password", "password-cache-canary");
    await act(() => router.navigate("/auth/sign-up", { formMethod: "post", formData: submission }));
    const oldLoader = router.state.loaderData["auth-sign-up"] as ScopedRouteData<unknown>;
    const oldAction = router.state.actionData?.["auth-sign-up"] as ScopedRouteData<unknown>;
    const issued: ScopedRouteData<unknown>[] = [];
    const unsubscribe = router.subscribe((state) => {
      for (const fetcher of state.fetchers.values()) {
        if (fetcher.data) issued.push(fetcher.data as ScopedRouteData<unknown>);
      }
    });
    await userEvent.type(screen.getByLabelText("Email"), "player@example.com");
    await userEvent.type(
      screen.getByLabelText("Password", { exact: true }),
      "password-cache-canary",
    );
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByText(/Request received/);
    expect(issued.some((value) => value.data !== null)).toBe(true);
    delayed = true;
    const channel = new BroadcastChannel("neurochess.identity");
    try {
      await act(async () => {
        channel.postMessage("changed");
      });
      await waitFor(() => expect(oldLoader.data).toBeNull());
      expect(oldAction.data).toBeNull();
      expect(issued.every((value) => value.data === null)).toBe(true);
      expect(screen.queryByText(/Request received/)).not.toBeInTheDocument();
      await act(async () => pending.resolve());
    } finally {
      unsubscribe();
      channel.close();
    }
    http.assertNoUnexpectedRequests();
  });

  it("hides the private page immediately while expiry is being resolved behind a pending destination", async () => {
    let expired = false;
    const destination = Promise.withResolvers<void>();
    const identityRead = Promise.withResolvers<void>();
    const http = createHttpMock({
      "GET /api/auth/get-session": async () => {
        if (expired) await identityRead.promise;
        return jsonResponse(expired ? null : session);
      },
      "GET /profile": () => jsonResponse(profile),
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, {
      initialEntries: ["/account"],
      configureRoutes: (routes) => {
        const history = routes[0]!
          .children!.find((route) => route.id === "public")!
          .children!.find((route) => route.id === "history")!;
        const loader = history.loader;
        history.loader = async (args) => {
          await destination.promise;
          return typeof loader === "function" ? loader(args) : null;
        };
      },
    });
    await screen.findByRole("heading", { name: "Your profile" });
    let navigation: Promise<void>;
    act(() => {
      navigation = router.navigate("/history");
    });
    expired = true;
    const channel = new BroadcastChannel("neurochess.identity");
    try {
      await act(async () => channel.postMessage("changed"));
      await waitFor(() => expect(screen.queryByLabelText("Username")).not.toBeInTheDocument());
      expect(screen.queryByText("Player")).not.toBeInTheDocument();
      await act(async () => {
        identityRead.resolve();
        destination.resolve();
        await navigation;
      });
      await screen.findByRole("heading", { name: "Sign in to continue" });
      expect(
        http.fetch.mock.calls.some(
          ([url]) => requestPath(url) === "/guest-session" || requestPath(url) === "/games/history",
        ),
      ).toBe(false);
    } finally {
      channel.close();
    }
    http.assertNoUnexpectedRequests();
  });

  it("submits a bootstrap reset token once under StrictMode and keeps it out of router results", async () => {
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      "POST /api/auth/reset-password": () => jsonResponse({ success: true }),
    });
    vi.stubGlobal("fetch", http.fetch);
    window.history.replaceState(null, "", "/auth/reset-password#token=reset-strict-canary");
    const entry = consumeAuthEntry();
    const read = vi.spyOn(entry, "readResetToken");
    const { router } = renderApp(
      { ...options, authEntry: entry },
      { strict: true, initialEntries: ["/auth/reset-password"] },
    );
    await userEvent.type(
      await screen.findByLabelText("Password", { exact: true }),
      "password-reset-canary",
    );
    expect(read).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Set new password" }));
    await screen.findByText(/Password updated/);
    expect(read).toHaveBeenCalledOnce();
    expect(entry.hasResetToken).toBe(false);
    expect(
      JSON.stringify([
        router.state.loaderData,
        router.state.actionData,
        [...router.state.fetchers],
        window.history.state as unknown,
      ]),
    ).not.toMatch(/reset-strict|password-reset/);
    http.assertNoUnexpectedRequests();
  });

  it("returns through shared onboarding to the exact authorized canonical game path", async () => {
    let completed = false;
    let signedIn = false;
    const path = `/games/${GAME_ID}`;
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(signedIn ? session : null),
      "GET /profile": () =>
        jsonResponse({ ...profile, completed, username: completed ? "Player" : null }),
      "POST /api/auth/sign-in/email": () => {
        signedIn = true;
        return jsonResponse({ success: true });
      },
      "POST /profile/onboarding": () => {
        completed = true;
        return jsonResponse(profile);
      },
      "GET /credentials": () => jsonResponse({ credentials: [] }),
      [`GET ${path}/details`]: () => jsonResponse({ snapshot: snapshot(), configuration: null }),
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(options, {
      initialEntries: ["/auth/sign-in?returnTo=" + encodeURIComponent(path)],
    });
    await userEvent.type(await screen.findByLabelText("Email"), "player@example.com");
    await userEvent.type(
      screen.getByLabelText("Password", { exact: true }),
      "password-signin-canary",
    );
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await userEvent.type(await screen.findByLabelText("Username"), "Player");
    expect(router.state.location.pathname).toBe(path);
    await userEvent.click(screen.getByRole("button", { name: "Finish profile" }));
    await screen.findByText("This game belongs to the development Sandbox.");
    expect(router.state.location.pathname).toBe(path);
    const saved = http.fetch.mock.calls.find(([url]) => requestPath(url) === "/profile/onboarding");
    expect(requestBody(saved?.[1])).toBe(JSON.stringify({ username: "Player" }));
    http.assertNoUnexpectedRequests();
  });
});
