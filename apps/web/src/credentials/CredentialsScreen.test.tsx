import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/App";
import { GAME_ID, jsonResponse, requestBody, requestPath } from "../test/fixtures";
import { createHttpMock } from "../test/http";
import { renderLocalized } from "../test/render";

const saved = {
  credentialId: GAME_ID,
  provider: "openai",
  label: "Arena key",
  maskedSuffix: "1234",
  createdAt: "2026-10-01T00:00:00.000Z",
};
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

describe("credential settings", () => {
  it("keeps an uncertain save blocked when focus supersedes its reconciliation read", async () => {
    window.history.replaceState(null, "", "/account/credentials");
    const reconciliation = Promise.withResolvers<Response>();
    const replacement = Promise.withResolvers<Response>();
    let reads = 0;
    let savedId = "";
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse(profile),
      "GET /credentials": () => {
        reads++;
        return reads === 1
          ? jsonResponse({ credentials: [] })
          : reads === 2
            ? reconciliation.promise
            : replacement.promise;
      },
      "POST /credentials": (init) => {
        savedId = (JSON.parse(requestBody(init)) as { credentialId: string }).credentialId;
        throw new Error("Lost acknowledgement");
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
    await screen.findByText(/No saved keys yet/);
    await userEvent.type(screen.getByLabelText("Label"), "Arena key");
    await userEvent.type(screen.getByLabelText("API key", { exact: true }), "save-fixture-1234");
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => {
      fireEvent(window, new Event("focus"));
    });
    await waitFor(() => expect(reads).toBe(3));
    await act(async () => {
      reconciliation.resolve(jsonResponse({ credentials: [] }));
    });
    await userEvent.type(screen.getByLabelText("Label"), "Duplicate attempt");
    await userEvent.type(screen.getByLabelText("API key", { exact: true }), "save-fixture-1234");
    await userEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Save key" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await act(async () => {
      replacement.resolve(jsonResponse({ credentials: [{ ...saved, credentialId: savedId }] }));
    });
    await screen.findByText("Key saved. Select it explicitly in game setup or paused recovery.");
    expect(
      http.fetch.mock.calls.filter(
        ([url, init]) => requestPath(url) === "/credentials" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    http.assertNoUnexpectedRequests();
  });
  it("reconciles a lost save response by its ID before offering another save", async () => {
    window.history.replaceState(null, "", "/account/credentials");
    let entries: (typeof saved)[] = [];
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse(profile),
      "GET /credentials": () => jsonResponse({ credentials: entries }),
      "POST /credentials": (init) => {
        const body = JSON.parse(requestBody(init)) as { credentialId: string };
        entries = [{ ...saved, credentialId: body.credentialId }];
        throw new Error("Lost acknowledgement");
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
    await screen.findByRole("heading", { name: "Saved provider keys" });
    await userEvent.type(screen.getByLabelText("Label"), "Arena key");
    await userEvent.type(screen.getByLabelText("API key", { exact: true }), "save-fixture-1234");
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));
    await screen.findByText("Key saved. Select it explicitly in game setup or paused recovery.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      http.fetch.mock.calls.filter(
        ([url, init]) => requestPath(url) === "/credentials" && init?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(screen.getByLabelText("API key", { exact: true })).toHaveValue("");
    http.assertNoUnexpectedRequests();
  });
  it("requires explicit consent, clears submitted keys, and confirms scoped deletion with Cancel focused", async () => {
    window.history.replaceState(null, "", "/account/credentials");
    let entries: (typeof saved)[] = [];
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse(profile),
      "GET /credentials": () => jsonResponse({ credentials: entries }),
      "POST /credentials": () => {
        entries = [saved];
        return jsonResponse(saved, 201);
      },
      "POST /credentials/revoke": () => {
        entries = [];
        return jsonResponse({ status: "deleted" });
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
    await screen.findByRole("heading", { name: "Saved provider keys" });
    const checkbox = screen.getByRole("checkbox", { name: "Save this key to my account" });
    expect(checkbox).not.toBeChecked();
    await userEvent.type(screen.getByLabelText("Label"), "Arena key");
    await userEvent.type(screen.getByLabelText("API key", { exact: true }), "private-fixture-1234");
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(
      http.fetch.mock.calls.filter(
        ([url, init]) => requestPath(url) === "/credentials" && init?.method === "POST",
      ),
    ).toHaveLength(0);
    await userEvent.click(checkbox);
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));
    await screen.findByText("Arena key");
    expect(screen.getByLabelText("API key", { exact: true })).toHaveValue("");
    expect(checkbox).not.toBeChecked();
    expect(document.body).not.toHaveTextContent("private-fixture-1234");
    const call = http.fetch.mock.calls.find(
      ([url, init]) => requestPath(url) === "/credentials" && init?.method === "POST",
    );
    expect(JSON.parse(requestBody(call?.[1]))).toMatchObject({
      save: true,
      label: "Arena key",
      apiKey: "private-fixture-1234",
      provider: "openai",
    });
    expect(new Headers(call?.[1]?.headers).get("x-neurochess-expected-account")).toBe(GAME_ID);
    await userEvent.click(screen.getByRole("button", { name: "Revoke Arena key" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "Revoke key" }));
    await waitFor(() => expect(screen.queryByText("Arena key")).not.toBeInTheDocument());
    http.assertNoUnexpectedRequests();
  });

  it("clears a draft on pagehide and fences late metadata when the account changes", async () => {
    window.history.replaceState(null, "", "/account/credentials");
    const response = Promise.withResolvers<Response>();
    let other = false;
    const http = createHttpMock({
      "GET /api/auth/get-session": () =>
        jsonResponse(
          other
            ? { ...session, user: { ...session.user, id: "20000000-0000-4000-8000-000000000002" } }
            : session,
        ),
      "GET /profile": () => jsonResponse(other ? { ...profile, username: "OtherPlayer" } : profile),
      "GET /credentials": () => (other ? jsonResponse({ credentials: [] }) : response.promise),
    });
    vi.stubGlobal("fetch", http.fetch);
    renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
    await screen.findByRole("heading", { name: "Saved provider keys" });
    await userEvent.type(screen.getByLabelText("API key", { exact: true }), "old-page-canary");
    const input = screen.getByLabelText("API key", { exact: true });
    await act(async () => {
      fireEvent(window, new Event("pagehide"));
    });
    expect(input).toHaveValue("");
    other = true;
    await act(async () => {
      fireEvent(window, new Event("focus"));
    });
    await screen.findByRole("link", { name: /OtherPlayer/ });
    await act(async () => {
      response.resolve(jsonResponse({ credentials: [saved] }));
    });
    expect(screen.queryByText("Arena key")).not.toBeInTheDocument();
    expect(screen.getByLabelText("API key", { exact: true })).toHaveValue("");
    http.assertNoUnexpectedRequests();
  });

  it("allows management before profile completion but never exposes controls to guests", async () => {
    window.history.replaceState(null, "", "/account/credentials");
    let signedIn = true;
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(signedIn ? session : null),
      "GET /profile": () => jsonResponse({ ...profile, completed: false, username: null }),
      "GET /credentials": () => jsonResponse({ credentials: [saved] }),
    });
    vi.stubGlobal("fetch", http.fetch);
    renderLocalized(<App apiBaseUrl="http://localhost:3001" sandboxEnabled={false} />);
    await screen.findByText("Arena key");
    signedIn = false;
    await act(async () => {
      fireEvent(window, new Event("focus"));
    });
    await screen.findByRole("heading", { name: "Sign in to continue" });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Arena key")).not.toBeInTheDocument();
    http.assertNoUnexpectedRequests();
  });
});
