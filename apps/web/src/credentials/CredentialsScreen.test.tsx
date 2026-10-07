import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { errorResponse, GAME_ID, jsonResponse, requestBody, requestPath } from "../test/fixtures";
import { createHttpMock } from "../test/http";
import { renderApp } from "../test/render";

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
  it("keeps the key and consent until the label passes local validation", async () => {
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse(profile),
      "GET /credentials": () => jsonResponse({ credentials: [] }),
      "POST /credentials": () => jsonResponse(saved, 201),
    });
    vi.stubGlobal("fetch", http.fetch);
    renderApp(
      { apiBaseUrl: "http://localhost:3001", sandboxEnabled: false },
      { initialEntries: ["/account/credentials"] },
    );
    await userEvent.type(
      await screen.findByLabelText("API key", { exact: true }),
      "save-fixture-1234",
    );
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("API key", { exact: true })).toHaveValue("save-fixture-1234");
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(http.fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    await userEvent.type(screen.getByLabelText("Label"), "Arena key");
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));
    await screen.findByText(/Key saved/);
    expect(screen.getByLabelText("API key", { exact: true })).toHaveValue("");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    http.assertNoUnexpectedRequests();
  });

  it.each(["invalid", "forbidden"])(
    "retains the uncertain save UUID when an explicit retry is %s",
    async (rejection) => {
      const ids: string[] = [];
      let rejectRetry = true;
      const http = createHttpMock({
        "GET /api/auth/get-session": () => jsonResponse(session),
        "GET /profile": () => jsonResponse(profile),
        "GET /credentials": () => jsonResponse({ credentials: [] }),
        "POST /credentials": (init) => {
          ids.push((JSON.parse(requestBody(init)) as { credentialId: string }).credentialId);
          if (ids.length === 1) throw new Error("Lost acknowledgement");
          return errorResponse(rejectRetry ? "CREDENTIAL_FORBIDDEN" : "CREDENTIAL_CONFLICT", 409);
        },
      });
      vi.stubGlobal("fetch", http.fetch);
      renderApp(
        { apiBaseUrl: "http://localhost:3001", sandboxEnabled: false },
        { initialEntries: ["/account/credentials"] },
      );
      await screen.findByText(/No saved keys yet/);
      const fill = async () => {
        await userEvent.type(screen.getByLabelText("Label"), "Arena key");
        await userEvent.type(
          screen.getByLabelText("API key", { exact: true }),
          "save-fixture-1234",
        );
      };
      const submit = async () => {
        const consent = screen.getByRole("checkbox");
        if (!(consent as HTMLInputElement).checked) await userEvent.click(consent);
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "Save key" })).toHaveAttribute(
            "aria-disabled",
            "false",
          ),
        );
        await userEvent.click(screen.getByRole("button", { name: "Save key" }));
      };
      await fill();
      await submit();
      await screen.findByText(/The operation could not be confirmed/);
      if (rejection === "forbidden") await fill();
      await submit();
      await waitFor(() =>
        expect(screen.queryByText(/The operation could not be confirmed/)).not.toBeInTheDocument(),
      );
      expect(screen.getByRole("alert")).toBeVisible();
      rejectRetry = false;
      await fill();
      await submit();
      await screen.findByText(/This save may already exist/);
      expect(ids).toHaveLength(rejection === "invalid" ? 2 : 3);
      expect(new Set(ids).size).toBe(1);
      expect(screen.queryByText(/Key saved/)).not.toBeInTheDocument();
      http.assertNoUnexpectedRequests();
    },
  );

  it("keeps the save UUID after a retry conflict when fresh metadata still cannot find it", async () => {
    const ids: string[] = [];
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse(profile),
      "GET /credentials": () => jsonResponse({ credentials: [] }),
      "POST /credentials": (init) => {
        ids.push((JSON.parse(requestBody(init)) as { credentialId: string }).credentialId);
        if (ids.length === 1) throw new Error("Lost acknowledgement");
        return errorResponse("CREDENTIAL_CONFLICT", 409);
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    renderApp(
      { apiBaseUrl: "http://localhost:3001", sandboxEnabled: false },
      { initialEntries: ["/account/credentials"] },
    );
    await screen.findByText(/No saved keys yet/);
    for (let attempt = 0; attempt < 3; attempt++) {
      await userEvent.type(screen.getByLabelText("Label"), "Arena key");
      await userEvent.type(screen.getByLabelText("API key", { exact: true }), "save-fixture-1234");
      await userEvent.click(screen.getByRole("checkbox"));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Save key" })).toHaveAttribute(
          "aria-disabled",
          "false",
        ),
      );
      await userEvent.click(screen.getByRole("button", { name: "Save key" }));
      await screen.findByText(
        attempt === 0 ? /The operation could not be confirmed/ : /This save may already exist/,
      );
    }
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(screen.queryByText(/Key saved/)).not.toBeInTheDocument();
    http.assertNoUnexpectedRequests();
  });

  it("resets submitted keys and fetcher results when identity changes during a save", async () => {
    let switched = false;
    const pending = Promise.withResolvers<Response>();
    const http = createHttpMock({
      "GET /api/auth/get-session": () =>
        jsonResponse(
          switched
            ? { ...session, user: { ...session.user, id: "20000000-0000-4000-8000-000000000002" } }
            : session,
        ),
      "GET /profile": () => jsonResponse(profile),
      "GET /credentials": () => jsonResponse({ credentials: [] }),
      "POST /credentials": () => pending.promise,
    });
    vi.stubGlobal("fetch", http.fetch);
    const { router } = renderApp(
      { apiBaseUrl: "http://localhost:3001", sandboxEnabled: false },
      { initialEntries: ["/account/credentials"] },
    );
    await screen.findByText(/No saved keys yet/);
    await userEvent.type(screen.getByLabelText("Label"), "Old account key");
    await userEvent.type(
      screen.getByLabelText("API key", { exact: true }),
      "old-secret-canary-1234",
    );
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(screen.getByLabelText("API key", { exact: true })).toHaveValue("");
    await waitFor(() =>
      expect([...router.state.fetchers.values()].some((item) => item.state === "submitting")).toBe(
        true,
      ),
    );
    switched = true;
    await act(async () => fireEvent(window, new Event("focus")));
    await waitFor(() =>
      expect([...router.state.fetchers.values()].every((item) => item.state === "idle")).toBe(true),
    );
    await act(async () => pending.resolve(jsonResponse(saved, 201)));
    await screen.findByText(/No saved keys yet/);
    expect(screen.queryByText(/Key saved/)).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(
      JSON.stringify([
        router.state.loaderData,
        router.state.actionData,
        [...router.state.fetchers],
        router.state.location.state,
      ]),
    ).not.toMatch(/old-secret|Old account key/);
    http.assertNoUnexpectedRequests();
  });

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
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: false });
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
  it("retries an unconfirmed save by its ID until the outcome is known", async () => {
    window.history.replaceState(null, "", "/account/credentials");
    let entries: (typeof saved)[] = [];
    const ids: string[] = [];
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(session),
      "GET /profile": () => jsonResponse(profile),
      "GET /credentials": () => jsonResponse({ credentials: entries }),
      "POST /credentials": (init) => {
        const { credentialId } = JSON.parse(requestBody(init)) as { credentialId: string };
        ids.push(credentialId);
        if (ids.length === 1) throw new Error("Lost acknowledgement");
        if (credentialId === ids[0]) {
          // The first request commits only after its reconciliation read missed it.
          entries = [{ ...saved, credentialId }];
          return errorResponse("CREDENTIAL_CONFLICT", 409);
        }
        const created = { ...saved, credentialId, label: "Second key" };
        entries = [created, ...entries];
        return jsonResponse(created, 201);
      },
    });
    vi.stubGlobal("fetch", http.fetch);
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: false });
    await screen.findByText(/No saved keys yet/);
    async function submit(label: string) {
      const button = await screen.findByRole("button", { name: "Save key" });
      await userEvent.type(screen.getByLabelText("Label"), label);
      await userEvent.type(screen.getByLabelText("API key", { exact: true }), "save-fixture-1234");
      await userEvent.click(screen.getByRole("checkbox"));
      await userEvent.click(button);
    }
    await submit("Arena key");
    await screen.findByText(/The operation could not be confirmed/);
    await submit("Arena key");
    await screen.findByText(
      "This save may already exist. Refresh your saved keys before saving again.",
    );
    expect(ids).toEqual([ids[0], ids[0]]);
    expect(await screen.findByText("Arena key")).toBeInTheDocument();
    expect(screen.queryByText(/Key saved/)).not.toBeInTheDocument();
    await submit("Second key");
    await screen.findByText("Key saved. Select it explicitly in game setup or paused recovery.");
    expect(ids).toHaveLength(3);
    expect(ids[2]).not.toBe(ids[0]);
    expect(await screen.findByText("Second key")).toBeInTheDocument();
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
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: false });
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
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: false });
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
    let reads = 0;
    const http = createHttpMock({
      "GET /api/auth/get-session": () =>
        jsonResponse(
          other
            ? { ...session, user: { ...session.user, id: "20000000-0000-4000-8000-000000000002" } }
            : session,
        ),
      "GET /profile": () => jsonResponse(other ? { ...profile, username: "OtherPlayer" } : profile),
      "GET /credentials": () =>
        other || ++reads === 1 ? jsonResponse({ credentials: [] }) : response.promise,
    });
    vi.stubGlobal("fetch", http.fetch);
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: false });
    await screen.findByRole("heading", { name: "Saved provider keys" });
    await userEvent.type(screen.getByLabelText("API key", { exact: true }), "old-page-canary");
    await userEvent.click(screen.getByRole("button", { name: "Refresh saved keys" }));
    await waitFor(() => expect(reads).toBe(2));
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
    renderApp({ apiBaseUrl: "http://localhost:3001", sandboxEnabled: false });
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
