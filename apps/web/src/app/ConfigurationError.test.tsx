// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConfigurationError } from "./ConfigurationError";
import { WebEnvironmentValidationError } from "./env";

describe("localized configuration errors", () => {
  it("renders catalog copy and variable names without exception text", () => {
    render(<ConfigurationError error={new WebEnvironmentValidationError(["VITE_API_BASE_URL"])} />);
    expect(screen.getByRole("heading", { name: "Configuration unavailable" })).toBeInTheDocument();
    expect(
      screen.getByText(/Check the following configuration variables: VITE_API_BASE_URL/),
    ).toBeInTheDocument();
    expect(document.title).toBe("Development sandbox · Neurochess Arena");
    expect(document.documentElement.lang).toBe("en");
  });

  it("never renders an unknown exception message", () => {
    render(<ConfigurationError error={new Error("configuration-secret-canary")} />);
    expect(document.body.textContent).not.toContain("configuration-secret-canary");
    expect(screen.getByText(/The application could not start/)).toBeInTheDocument();
  });
});
