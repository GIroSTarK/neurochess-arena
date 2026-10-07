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
    expect(screen.getByLabelText("Email")).toHaveValue(email);
    expect(screen.getByLabelText("Password", { exact: true })).toHaveValue(password);
    http.assertNoUnexpectedRequests();
  },
);
