import {
  aiGameConfigurationSchema,
  type CredentialMetadata,
  modelDiscoveryRequestSchema,
} from "@neurochess/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAiApi } from "../api/ai-client";
import { createSessionCredentials } from "../api/session-credentials";
import { deferred, setupModels } from "../test/ai-setup";
import {
  errorResponse,
  GAME_ID,
  jsonResponse,
  requestBody,
  requestPath,
  snapshot,
} from "../test/fixtures";
import { renderLocalized } from "../test/render";

import { ArenaSetupScreen } from "./ArenaSetupScreen";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((dispose) => dispose()));

function fixture(models = setupModels, saved?: readonly CredentialMetadata[]) {
  const lifetime = new AbortController();
  const credentials = createSessionCredentials(lifetime.signal);
  cleanup.push(() => lifetime.abort());
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
    const path = requestPath(input);
    if (path === "/games/unfinished") return jsonResponse({ game: null });
    if (path === "/guest-session") return jsonResponse({ status: "ready" });
    if (path === "/providers/models") {
      const body = modelDiscoveryRequestSchema.parse(JSON.parse(requestBody(init)));
      return jsonResponse({ ok: true, models: models(body.provider) });
    }
    if (path === "/games") {
      return jsonResponse(
        {
          snapshot: snapshot(),
          configuration: aiGameConfigurationSchema.parse(JSON.parse(requestBody(init))),
        },
        201,
      );
    }
    throw new Error("Unexpected test request");
  });
  const onCreated = vi.fn();
  const onReturnToGame = vi.fn();
  const view = renderLocalized(
    <StrictMode>
      <ArenaSetupScreen
        api={createAiApi("https://api.example.test", { fetch })}
        credentials={credentials}
        sandboxEnabled
        onCreated={onCreated}
        onReturnToGame={onReturnToGame}
        {...(saved
          ? {
              savedCredentials: {
                credentials: saved,
                phase: "ready" as const,
                onRefresh: () => undefined,
              },
            }
          : {})}
      />
    </StrictMode>,
  );
  return { ...view, credentials, fetch, onCreated, onReturnToGame };
}

it("uses independently chosen saved and session credentials without returning saved plaintext", async () => {
  const saved = {
    credentialId: GAME_ID,
    provider: "openai" as const,
    label: "White saved",
    maskedSuffix: "1234",
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  const { fetch, credentials } = fixture(setupModels, [saved]);
  const white = within(await screen.findByRole("group", { name: "White" }));
  await waitFor(() =>
    expect(white.getByLabelText("Credential source")).toHaveAttribute("aria-disabled", "false"),
  );
  expect(white.getByLabelText("Credential source")).toHaveValue("session");
  await userEvent.selectOptions(white.getByLabelText("Credential source"), GAME_ID);
  expect(white.queryByLabelText("API key", { exact: true })).not.toBeInTheDocument();
  await userEvent.click(white.getByRole("button", { name: "Load models" }));
  await waitFor(() =>
    expect(white.getByRole("combobox", { name: "Model" })).toHaveAttribute(
      "aria-disabled",
      "false",
    ),
  );
  const discovery = fetch.mock.calls.find(([url]) => requestPath(url) === "/providers/models");
  expect(JSON.parse(requestBody(discovery?.[1]))).toEqual({
    provider: "openai",
    credentialId: GAME_ID,
  });
  expect(
    within(screen.getByRole("group", { name: "Black" })).getByLabelText("API key", { exact: true }),
  ).toHaveValue("");
  expect(credentials.require("white", "openai")).toEqual({ credentialId: GAME_ID });
  await userEvent.selectOptions(white.getByLabelText("Credential source"), "session");
  expect(white.getByLabelText("API key", { exact: true })).toHaveValue("");
  expect(() => credentials.require("white", "openai")).toThrow();
});

async function loadModels(color: "White" | "Black", { typeKey = false } = {}) {
  const user = userEvent.setup();
  const seat = within(screen.getByRole("group", { name: color }));
  await waitFor(() =>
    expect(seat.getByLabelText("Provider")).toHaveAttribute("aria-disabled", "false"),
  );
  expect(seat.getByLabelText("Provider")).toHaveValue("openai");
  const key = seat.getByLabelText("API key");
  if (typeKey) {
    await user.type(key, `${color}-key-sentinel`);
  } else {
    // Most cases need a credential, not a keystroke-by-keystroke edit. Pasting
    // still exercises the real field's change, validation and blur handlers.
    await user.click(key);
    await user.paste(`${color}-key-sentinel`);
  }
  await user.click(seat.getByRole("button", { name: "Load models" }));
  await seat.findByText("Models loaded. Choose a model to continue.");
  const model = seat.getByRole("combobox", { name: "Model" });
  return { user, seat, model };
}

async function selectModel(color: "White" | "Black", { keyboard = false } = {}) {
  const { user, seat, model } = await loadModels(color, { typeKey: keyboard });
  await user.click(model);
  if (keyboard) {
    await user.type(model, "model-a");
    await user.keyboard("{ArrowDown}{Enter}");
  } else {
    await user.click(seat.getByRole("option", { name: /^Model A \(test fixture\)/ }));
  }
  return { user, seat, model };
}

describe("Arena setup presentation and validated API handoff", () => {
  it.each(["white", "black"] as const)(
    "selects a %s human and renders only the AI credential controls",
    async (color) => {
      const { onCreated } = fixture();
      const user = userEvent.setup();
      await waitFor(() =>
        expect(screen.getByLabelText("Game mode")).toHaveAttribute("aria-disabled", "false"),
      );
      await user.selectOptions(screen.getByLabelText("Game mode"), "ai_vs_human");
      await user.selectOptions(screen.getByLabelText("Your color"), color);
      expect(screen.getAllByLabelText("API key")).toHaveLength(1);
      expect(screen.getByText("You · Human player")).toBeVisible();
      await selectModel(color === "white" ? "Black" : "White");
      await user.click(screen.getByRole("button", { name: "Start game" }));
      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
      expect(onCreated.mock.calls[0]?.[0]).toMatchObject({
        configuration: {
          mode: "ai_vs_human",
          seats: { [color]: { type: "human" } },
        },
      });
    },
  );

  it("disables empty key reveal independently of key validity and resets masking when cleared", async () => {
    const { fetch } = fixture();
    const user = userEvent.setup();
    const white = within(screen.getByRole("group", { name: "White" }));
    const black = within(screen.getByRole("group", { name: "Black" }));
    await waitFor(() =>
      expect(white.getByLabelText("Provider")).toHaveAttribute("aria-disabled", "false"),
    );
    const input = white.getByLabelText("API key");
    const show = white.getByRole("button", { name: "Show key" });
    expect(show).toHaveAttribute("aria-disabled", "true");
    await user.click(input);
    await user.tab();
    expect(show).toHaveFocus();
    await user.keyboard("{Enter} ");
    expect(input).toHaveAttribute("type", "password");
    expect(show).toHaveAttribute("aria-pressed", "false");
    await user.type(input, "invalid key with spaces");
    expect(show).toHaveAttribute("aria-disabled", "false");
    expect(white.getByRole("button", { name: "Load models" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(black.getByRole("button", { name: "Show key" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(show);
    expect(input).toHaveAttribute("type", "text");
    await user.clear(input);
    expect(input).toHaveAttribute("type", "password");
    expect(white.getByRole("button", { name: "Show key" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.type(input, "replacement-key");
    expect(input).toHaveAttribute("type", "password");
    expect(show).toHaveAttribute("aria-disabled", "false");
    await user.selectOptions(white.getByLabelText("Provider"), "google");
    expect(white.getByRole("button", { name: "Show key" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(fetch.mock.calls.every(([url]) => requestPath(url) === "/games/unfinished")).toBe(true);
  });

  it("supports independent keyboard selection, bounded parameters, and key-free creation", async () => {
    const { onCreated, fetch, credentials } = fixture();
    expect(fetch.mock.calls.every(([url]) => requestPath(url) === "/games/unfinished")).toBe(true);
    const { user, seat: white } = await selectModel("White", { keyboard: true });
    await user.click(white.getByText("Advanced parameters"));
    await user.type(white.getByLabelText("Temperature"), "0.3");
    const { seat: black } = await selectModel("Black", { keyboard: true });
    await user.click(black.getByText("Advanced parameters"));
    await user.selectOptions(black.getByLabelText("Reasoning effort"), "high");
    expect(black.getByLabelText("Temperature")).toHaveValue("");
    const start = screen.getByRole("button", { name: "Start game" });
    expect(start).toHaveAttribute("aria-disabled", "false");
    await user.click(start);
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated.mock.calls[0]?.[0]).toMatchObject({
      configuration: {
        mode: "ai_vs_ai",
        seats: {
          white: { parameters: { temperature: 0.3 } },
          black: { parameters: { reasoningEffort: "high" } },
        },
      },
    });
    expect(JSON.stringify(onCreated.mock.calls)).not.toContain("sentinel");
    expect(credentials.require("white", "openai")).toEqual({ apiKey: "White-key-sentinel" });
    expect(credentials.require("black", "openai")).toEqual({ apiKey: "Black-key-sentinel" });
    for (const [input, init] of fetch.mock.calls) {
      expect(input instanceof Request ? input.url : input.toString()).not.toContain("sentinel");
      if (requestPath(input) !== "/providers/models") {
        expect(requestBody(init)).not.toContain("sentinel");
      }
    }
    expect(
      JSON.stringify({ local: localStorage, session: sessionStorage, name: window.name }),
    ).not.toContain("sentinel");
  });

  it("keeps parameter errors accessible, filters unsupported controls, and gates Start", async () => {
    fixture();
    const { user, seat, model } = await selectModel("White");
    await selectModel("Black");
    await user.click(seat.getByText("Advanced parameters"));
    const tokens = seat.getByLabelText("Maximum output tokens");
    await user.type(tokens, "3");
    await user.tab();
    expect(tokens).toHaveAttribute("aria-invalid", "true");
    expect(tokens).toHaveAccessibleDescription("Enter a valid value from 16 to 4096.");
    expect(screen.getByRole("button", { name: "Start game" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.click(model);
    await user.type(model, "unknown");
    await user.keyboard("{Enter}");
    expect(seat.queryByLabelText("Temperature")).not.toBeInTheDocument();
    expect(seat.getByText(/Move support is unknown/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Start game" })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    await user.click(model);
    await user.type(model, "unsupported");
    await user.keyboard("{Escape}");
    expect(model).toHaveValue("Unknown model (test fixture)");
    expect(model).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    await user.type(model, "unsupported");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Start game" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("masks keys and clears DOM values, catalogs and readiness on provider change and pagehide", async () => {
    const { credentials } = fixture();
    const { user, seat } = await selectModel("White", { keyboard: true });
    expect(seat.getByLabelText("API key")).toHaveAttribute("type", "password");
    await user.click(seat.getByRole("button", { name: "Show key" }));
    expect(seat.getByLabelText("API key")).toHaveAttribute("type", "text");
    await user.selectOptions(seat.getByLabelText("Provider"), "google");
    expect(seat.getByLabelText("API key")).toHaveValue("");
    expect(seat.getByLabelText("API key")).toHaveAttribute("type", "password");
    expect(() => credentials.require("white", "openai")).toThrow();
    await user.type(seat.getByLabelText("API key"), "replacement-key");
    fireEvent(window, new Event("pagehide"));
    expect(seat.getByLabelText("API key")).toHaveValue("");
    expect(() => credentials.require("white", "google")).toThrow();
  });

  it("shows loading, empty, invalid-key, unavailable and no-match guidance without raw errors", async () => {
    const { fetch } = fixture();
    const { user, seat, model } = await loadModels("White");
    await user.click(model);
    await user.type(model, "no-such-model");
    expect(seat.getByText(/No matching models/)).toBeVisible();
    await user.keyboard("{Escape}");
    const pending = deferred<Response>();
    fetch
      .mockResolvedValueOnce(jsonResponse({ status: "ready" }))
      .mockReturnValueOnce(pending.promise);
    await user.click(seat.getByRole("button", { name: "Refresh models" }));
    expect(seat.getByRole("button", { name: "Loading models…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    pending.resolve(jsonResponse({ ok: true, models: [] }));
    await seat.findByText(/No models are available/);
    fetch
      .mockResolvedValueOnce(jsonResponse({ status: "ready" }))
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: { code: "provider_auth" } }));
    await user.click(seat.getByRole("button", { name: "Refresh models" }));
    await seat.findByText(/This key was rejected/);
    expect(seat.getByLabelText("API key")).toHaveAttribute("aria-invalid", "true");
    fetch
      .mockResolvedValueOnce(jsonResponse({ status: "ready" }))
      .mockResolvedValueOnce(jsonResponse({ ok: false, rawError: "never-show-this" }));
    await user.click(seat.getByRole("button", { name: "Load models" }));
    await seat.findByText(/Setup could not be loaded/);
    expect(screen.queryByText(/never-show-this/)).not.toBeInTheDocument();
  });

  it("hands an authorized creation conflict to its owner without navigating or playing", async () => {
    const { fetch, onReturnToGame, onCreated } = fixture();
    await selectModel("White");
    await selectModel("Black");
    fetch
      .mockResolvedValueOnce(jsonResponse({ status: "ready" }))
      .mockResolvedValueOnce(errorResponse("GAME_CONFLICT", 409, snapshot()));
    await userEvent.click(screen.getByRole("button", { name: "Start game" }));
    const back = await screen.findByRole("button", { name: "Return to game" });
    expect(
      screen.getByText(
        "You already have a game in progress. Return to it before starting another.",
      ),
    ).toBeVisible();
    await userEvent.click(back);
    expect(onReturnToGame).toHaveBeenCalledWith(GAME_ID);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("renders discovered model names as text, including after selection", async () => {
    const untrusted = '<img src=x onerror="alert(1)">';
    fixture((provider) =>
      setupModels(provider).map((model, index) =>
        index === 0 ? { ...model, name: untrusted } : model,
      ),
    );
    const { user, seat, model } = await loadModels("White");
    await user.click(model);
    expect(seat.getByRole("option", { name: /<img src=x/ })).toBeVisible();
    await user.keyboard("{Enter}");
    expect(seat.getByText(untrusted)).toBeVisible();
    expect(model).toHaveValue(untrusted);
    expect(seat.queryByRole("img")).not.toBeInTheDocument();
  });
});
