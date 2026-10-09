import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { GAME_ID, jsonResponse, requestBody } from "../test/fixtures";
import { createHttpMock } from "../test/http";
import { renderApp } from "../test/render";

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it.each(["success", "failure", "lost response", "stale"])(
  "confirms account deletion and reports %s accurately",
  async (outcome) => {
    window.history.replaceState(null, "", "/account");
    let exists = true;
    let requests = 0;
    const pending = Promise.withResolvers<void>();
    const http = createHttpMock({
      "GET /api/auth/get-session": () =>
        jsonResponse(
          exists
            ? {
                user: { id: GAME_ID, email: "private@example.com", emailVerified: true },
                session: { expiresAt: "2027-10-01T00:00:00.000Z" },
              }
            : null,
        ),
      "GET /profile": () =>
        jsonResponse({
          username: "Player",
          completed: true,
          avatar: { source: "initials", initials: "PL" },
        }),
      "POST /api/auth/delete-account": async (init) => {
        requests++;
        expect(new Headers(init?.headers).get("x-neurochess-expected-account")).toBe(GAME_ID);
        expect(requestBody(init)).toBe(JSON.stringify({ confirm: true }));
        await pending.promise;
        if (outcome === "success" || outcome === "lost response") exists = false;
        if (outcome === "lost response") throw new TypeError("network");
        if (outcome !== "success") {
          return jsonResponse(
            {
              code: outcome === "stale" ? "AUTH_REAUTH_REQUIRED" : "AUTH_UNAVAILABLE",
              message: "safe",
              requestId: "test",
            },
            outcome === "stale" ? 403 : 500,
          );
        }
        return jsonResponse({ success: true });
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: false });
    const trigger = await screen.findByRole("button", { name: "Delete account" });
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(dialog).toHaveTextContent(/unfinished shared human games are aborted/i);
    expect(dialog).toHaveTextContent(/other participants keep anonymized history/i);
    expect(dialog).toHaveTextContent(/backups/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(trigger).toHaveFocus();
    expect(requests).toBe(0);
    await userEvent.click(trigger);
    await userEvent.dblClick(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Permanently delete account",
      }),
    );
    await act(async () => pending.resolve());
    if (outcome === "success") {
      expect(await screen.findByRole("heading", { name: "Account deleted" })).toHaveFocus();
      expect(screen.queryByRole("textbox", { name: "Username" })).not.toBeInTheDocument();
    } else if (outcome === "stale") {
      await screen.findAllByText(/Sign in again, then return to Account/);
      expect(screen.getByRole("link", { name: "Sign in again" })).toBeInTheDocument();
    } else {
      await screen.findByText(/We could not confirm account deletion/);
      expect(screen.queryByRole("heading", { name: "Account deleted" })).not.toBeInTheDocument();
    }
    expect(requests).toBe(1);
    http.assertNoUnexpectedRequests();
  },
);
