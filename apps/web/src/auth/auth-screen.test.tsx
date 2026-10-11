import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { errorResponse, jsonResponse } from "../test/fixtures";
import { createHttpMock } from "../test/http";
import { renderApp } from "../test/render";

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

it("replaces the previous auth error as soon as a retry starts", async () => {
  const response = Promise.withResolvers<Response>();
  let calls = 0;
  const http = createHttpMock({
    "GET /api/auth/get-session": () => jsonResponse(null),
    "POST /api/auth/request-password-reset": () =>
      ++calls === 1 ? errorResponse("AUTH_UNAVAILABLE", 503) : response.promise,
  });
  vi.stubGlobal("fetch", http.fetch);
  renderApp(
    { apiBaseUrl: "http://localhost:3001", sandboxEnabled: false },
    { initialEntries: ["/auth/forgot-password"] },
  );
  await userEvent.type(await screen.findByLabelText("Email"), "player@example.com");
  await userEvent.click(screen.getByRole("button", { name: "Request reset link" }));
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: "Request reset link" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await act(async () => response.resolve(jsonResponse({ status: "accepted", message: "receipt" })));
  await screen.findByText(/Request received/);
  http.assertNoUnexpectedRequests();
});

it("dismisses the callback error when an invalid local submission is attempted", async () => {
  const http = createHttpMock({ "GET /api/auth/get-session": () => jsonResponse(null) });
  vi.stubGlobal("fetch", http.fetch);
  renderApp(
    { apiBaseUrl: "http://localhost:3001", sandboxEnabled: false },
    { initialEntries: ["/auth/sign-in?auth=oauth-error&code=AUTH_OAUTH_CANCELLED"] },
  );
  await screen.findByRole("alert");
  await userEvent.type(screen.getByLabelText("Email"), "invalid");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid email address.");
  http.assertNoUnexpectedRequests();
});

it.each([
  { button: "Sign in", endpoint: "/api/auth/sign-in/email", code: "AUTH_INVALID_CREDENTIALS" },
  {
    button: "Continue with Google",
    endpoint: "/api/auth/sign-in/social",
    code: "AUTH_OAUTH_FAILED",
  },
] as const)(
  "preserves the email during and after a failed $button attempt",
  async ({ button, endpoint, code }) => {
    const pending = Promise.withResolvers<Response>();
    const http = createHttpMock({
      "GET /api/auth/get-session": () => jsonResponse(null),
      [`POST ${endpoint}`]: () => pending.promise,
    });
    vi.stubGlobal("fetch", http.fetch);
    renderApp(
      { apiBaseUrl: "http://localhost:3001", sandboxEnabled: false },
      { initialEntries: ["/auth/sign-in"] },
    );
    await userEvent.type(await screen.findByLabelText("Email"), "player@example.com");
    await userEvent.type(screen.getByLabelText("Password", { exact: true }), "password-fixture");
    await userEvent.click(screen.getByRole("button", { name: button }));
    expect(screen.getByLabelText("Email")).toHaveValue("player@example.com");
    expect(screen.getByLabelText("Password", { exact: true })).toHaveValue("");
    await act(async () => pending.resolve(errorResponse(code, 401)));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Email")).toHaveValue("player@example.com");
    http.assertNoUnexpectedRequests();
  },
);

it.each([
  {
    path: "/auth/sign-in",
    button: "Sign in",
    email: "invalid",
    password: "password-fixture",
    field: "Email",
  },
  {
    path: "/auth/sign-up",
    button: "Create account",
    email: "player@example.com",
    password: "short",
    field: "Password",
  },
])(
  "preserves input when $path rejects the $field locally",
  async ({ path, button, email, password, field }) => {
    const http = createHttpMock({ "GET /api/auth/get-session": () => jsonResponse(null) });
    vi.stubGlobal("fetch", http.fetch);
    renderApp(
      { apiBaseUrl: "http://localhost:3001", sandboxEnabled: false },
      { initialEntries: [path] },
    );
    await userEvent.type(await screen.findByLabelText("Email"), email);
    await userEvent.type(screen.getByLabelText("Password", { exact: true }), password);
    await userEvent.click(screen.getByRole("button", { name: button }));
    expect(screen.getByLabelText(field, { exact: true })).toHaveAttribute("aria-invalid", "true");
    const message =
      field === "Email"
        ? "Enter a valid email address."
        : "Enter a password. New passwords must contain 12–128 characters.";
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByLabelText(field, { exact: true })).toHaveAccessibleDescription(message);
    expect(screen.getByRole("button", { name: button })).toHaveFocus();
    expect(screen.getByLabelText("Email")).toHaveValue(email);
    expect(screen.getByLabelText("Password", { exact: true })).toHaveValue(password);
    http.assertNoUnexpectedRequests();
  },
);
