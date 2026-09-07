import {
  type AiGameConfiguration,
  lifecycleCommandSchema,
  modelDiscoveryRequestSchema,
} from "@neurochess/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import { catalogResponse } from "../../../../test/ai-models";
import { errorResponse, jsonResponse, requestBody, requestPath, snapshot } from "../test/fixtures";
import { renderLocalized } from "../test/render";

import { AiSetup } from "./AiSetup";

function mount(
  override: (
    path: string,
    options?: RequestInit,
  ) => Response | Promise<Response> | undefined = () => undefined,
) {
  const fetch = vi.fn<typeof globalThis.fetch>((input, options) => {
    const path = requestPath(input);
    const response = override(path, options);
    if (response) return Promise.resolve(response);
    if (path === "/guest-session") return Promise.resolve(jsonResponse({ status: "ready" }));
    if (path === "/ai/providers") {
      return Promise.resolve(
        jsonResponse({
          providers: [
            { id: "openai", name: "OpenAI" },
            { id: "anthropic", name: "Anthropic" },
          ],
        }),
      );
    }
    if (path.endsWith("/unfinished")) return Promise.resolve(jsonResponse({ snapshot: null }));
    if (path === "/ai/models") {
      const { credential } = modelDiscoveryRequestSchema.parse(
        JSON.parse(requestBody(options)) as unknown,
      );
      return Promise.resolve(jsonResponse(catalogResponse(credential.provider)));
    }
    if (path === "/ai/games") return Promise.resolve(jsonResponse(snapshot(), 201));
    if (path.startsWith("/ai/games/")) {
      return Promise.resolve(
        jsonResponse({
          snapshot: snapshot(),
          configuration: {
            mode: "ai_vs_ai",
            white: { provider: "openai", modelId: "fixture-full", parameters: {} },
            black: { provider: "anthropic", modelId: "fixture-full", parameters: {} },
          },
        }),
      );
    }
    if (path.endsWith("/ai-turn")) return new Promise<Response>(() => undefined);
    throw new Error("Unexpected test request");
  });
  vi.stubGlobal("fetch", fetch);
  const rendered = renderLocalized(
    <StrictMode>
      <AiSetup apiBaseUrl="http://localhost:3001" />
    </StrictMode>,
  );
  return { fetch, ...rendered };
}

function seat(color: "White" | "Black") {
  return within(screen.getByRole("region", { name: `${color} configuration` }));
}

async function configure(
  color: "White" | "Black",
  provider = "openai",
  key = `fixture-${color}-key`,
) {
  const user = userEvent.setup();
  const panel = seat(color);
  await waitFor(() =>
    expect(panel.getByRole("combobox", { name: "Provider" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    ),
  );
  await user.selectOptions(panel.getByRole("combobox", { name: "Provider" }), provider);
  await user.type(panel.getByLabelText("API key", { exact: true }), key);
  await user.click(panel.getByRole("button", { name: "Load models" }));
  const picker = await panel.findByRole("combobox", { name: "Model" });
  await user.click(picker);
  await user.keyboard("{ArrowDown}{Enter}");
  return { user, panel };
}

function creations(fetch: ReturnType<typeof mount>["fetch"]) {
  return fetch.mock.calls
    .filter(([input]) => requestPath(input) === "/ai/games")
    .map(([, options]) => JSON.parse(requestBody(options)) as unknown);
}

describe("AI setup", () => {
  it.each(["ai_vs_ai", "white", "black"] as const)(
    "recovers %s with saved configuration and gates explicit continuation on every missing key",
    async (mode) => {
      const ai = {
        provider: "openai",
        modelId: "saved-model",
        parameters: { temperature: 0 },
      } as const;
      const configuration: AiGameConfiguration =
        mode === "ai_vs_ai"
          ? { mode, white: ai, black: { ...ai, parameters: { temperature: 1.5 } } }
          : { mode: "ai_vs_human", humanColor: mode, ai };
      const history = ["g1f3", "g8f6", "f3g1", "f6g8"];
      let current = snapshot(history);
      const { fetch } = mount((path, options) => {
        if (path === "/ai/games/unfinished") return jsonResponse({ snapshot: current });
        if (path === `/ai/games/${current.gameId}`) {
          return jsonResponse({ snapshot: current, configuration });
        }
        if (path === `/games/${current.gameId}`) return jsonResponse(current);
        if (path.endsWith("/lifecycle")) {
          const command = lifecycleCommandSchema.parse(JSON.parse(requestBody(options)) as unknown);
          current = snapshot(history, {
            state: command.action === "resume" ? "active" : "paused",
            version: command.expectedVersion + 1,
            ...(command.action === "pause" ? { legalMoves: [] } : {}),
          });
          return jsonResponse(current);
        }
        return undefined;
      });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Return to game" }));
      await screen.findByText("Game paused", { exact: true });
      const resume = screen.getByRole("button", { name: "Resume" });
      expect(resume).toHaveAttribute("aria-disabled", "true");
      const enter = screen.getByRole("button", { name: "Enter missing keys" });
      await user.click(enter);
      const colors =
        mode === "ai_vs_ai" ? ["White", "Black"] : [mode === "white" ? "Black" : "White"];
      expect(within(screen.getByRole("dialog")).getAllByLabelText(/API key/)).toHaveLength(
        colors.length,
      );
      await user.type(
        screen.getByLabelText(`${colors[0] ?? "White"} · openai API key`),
        "discarded-key",
      );
      await user.keyboard("{Escape}");
      expect(enter).toHaveFocus();
      expect(resume).toHaveAttribute("aria-disabled", "true");
      await user.click(enter);
      for (const color of colors) {
        const field = screen.getByLabelText(`${color} · openai API key`);
        expect(field).toHaveValue("");
        expect(field).toHaveAttribute("type", "password");
        expect(screen.getByRole("button", { name: "Use keys for this page" })).toHaveAttribute(
          "aria-disabled",
          "true",
        );
        await user.type(field, `reentered-${color}`);
      }
      await user.click(screen.getByRole("button", { name: "Use keys for this page" }));
      expect(resume).toHaveAttribute("aria-disabled", "false");
      expect(current.state).toBe("paused");
      expect(current.moves.map(({ uci }) => uci)).toEqual(history);
      const turns = () =>
        fetch.mock.calls.filter(([input]) => requestPath(input).endsWith("/ai-turn"));
      expect(turns()).toHaveLength(0);
      await user.click(resume);
      await waitFor(() => expect(current.state).toBe("active"));
      if (mode !== "white") {
        await waitFor(() => expect(turns()).toHaveLength(1));
        expect(JSON.parse(requestBody(turns()[0]?.[1])) as unknown).toMatchObject({
          credential: { provider: "openai", apiKey: "reentered-White" },
        });
      } else expect(turns()).toHaveLength(0);
    },
  );

  it("returns from the back-forward cache through paused recovery without launching another turn", async () => {
    const initial = snapshot();
    const accepted = snapshot(["e2e4"]);
    const paused = snapshot(["e2e4"], { state: "paused", legalMoves: [], version: 2 });
    const { fetch } = mount((path) => {
      if (path === `/games/${initial.gameId}`) return jsonResponse(accepted);
      if (path.endsWith("/lifecycle")) return jsonResponse(paused);
      return undefined;
    });
    const { user } = await configure("White");
    await configure("Black");
    await user.click(screen.getByRole("button", { name: "Start game" }));
    const turns = () =>
      fetch.mock.calls.filter(([input]) => requestPath(input).endsWith("/ai-turn"));
    await waitFor(() => expect(turns()).toHaveLength(1));
    const bootstraps = fetch.mock.calls.filter(
      ([input]) => requestPath(input) === "/guest-session",
    ).length;
    fireEvent(window, new PageTransitionEvent("pagehide", { persisted: true }));
    expect(turns()[0]?.[1]?.signal?.aborted).toBe(true);
    fireEvent(window, new PageTransitionEvent("pageshow", { persisted: true }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next move" })).toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    expect(screen.getByRole("button", { name: "Resume" })).toHaveAttribute("aria-disabled", "true");
    expect(turns()).toHaveLength(1);
    await screen.findByText("Game paused", { exact: true });
    expect(
      fetch.mock.calls.filter(([input]) => requestPath(input) === "/guest-session"),
    ).toHaveLength(bootstraps);
    await user.click(screen.getByRole("button", { name: "Enter missing keys" }));
    for (const field of within(screen.getByRole("dialog")).getAllByLabelText(/API key/)) {
      expect(field).toHaveValue("");
    }
    const lifecycle = fetch.mock.calls
      .filter(([input]) => requestPath(input).endsWith("/lifecycle"))
      .at(-1);
    expect(JSON.parse(requestBody(lifecycle?.[1])) as unknown).toMatchObject({
      action: "pause",
      expectedVersion: 1,
    });
  });

  it.each(["recovery", "stop"] as const)(
    "returns to setup and bootstraps the session after %s loses access",
    async (source) => {
      const initial = snapshot();
      let returning = false;
      const { fetch } = mount((path) => {
        if (path === "/ai/games/unfinished") {
          return jsonResponse({ snapshot: source === "recovery" && !returning ? initial : null });
        }
        if (path === `/games/${initial.gameId}` || path.endsWith("/lifecycle")) {
          return errorResponse("UNAUTHORIZED", 401);
        }
        return undefined;
      });
      const user = userEvent.setup();
      if (source === "recovery") {
        await user.click(await screen.findByRole("button", { name: "Return to game" }));
      } else {
        await configure("White");
        await configure("Black");
        await user.click(screen.getByRole("button", { name: "Start game" }));
        await user.click(await screen.findByRole("button", { name: "Stop game" }));
        await user.click(
          within(screen.getByRole("dialog")).getByRole("button", { name: "Stop game" }),
        );
      }
      const exit = await screen.findByRole("button", { name: "Return to setup" });
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This game is no longer available to your guest session.",
      );
      expect(screen.queryByRole("grid", { name: "Chessboard" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry recovery" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Stop game" })).not.toBeInTheDocument();
      const bootstraps = () =>
        fetch.mock.calls.filter(([input]) => requestPath(input) === "/guest-session").length;
      const before = bootstraps();
      returning = true;
      await user.click(exit);
      await waitFor(() => expect(bootstraps()).toBe(before + 1));
      await waitFor(() =>
        expect(seat("White").getByRole("combobox", { name: "Provider" })).toHaveAttribute(
          "aria-disabled",
          "false",
        ),
      );
      expect(screen.getByRole("button", { name: "Start game" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(screen.queryByRole("button", { name: "Return to game" })).not.toBeInTheDocument();
      expect(
        fetch.mock.calls.filter(([input]) => requestPath(input).endsWith("/lifecycle")),
      ).toHaveLength(source === "stop" ? 1 : 0);
      expect(creations(fetch)).toHaveLength(source === "stop" ? 1 : 0);
    },
  );

  it.each(["White", "Black"] as const)(
    "masks a different draft on mode switches when the human plays %s",
    async (humanColor) => {
      mount();
      const user = userEvent.setup();
      await user.click(screen.getByRole("radio", { name: /AI vs human/ }));
      await user.click(
        within(screen.getByRole("group", { name: "Your color" })).getByRole("radio", {
          name: humanColor,
        }),
      );
      const opponentColor = humanColor === "White" ? "Black" : "White";
      await configure(opponentColor, "openai", "fixture-opponent-key");
      expect(seat(opponentColor).getByLabelText("API key", { exact: true })).toHaveAttribute(
        "type",
        "password",
      );
      await user.click(screen.getByRole("radio", { name: /AI vs AI/ }));
      await configure("White");
      await user.click(seat("White").getByRole("button", { name: "Show key" }));
      await user.click(screen.getByRole("radio", { name: /AI vs human/ }));
      expect(seat(opponentColor).getByLabelText("API key", { exact: true })).toHaveValue(
        "fixture-opponent-key",
      );
      expect(seat(opponentColor).getByLabelText("API key", { exact: true })).toHaveAttribute(
        "type",
        "password",
      );
      await user.click(seat(opponentColor).getByRole("button", { name: "Show key" }));
      await user.click(screen.getByRole("radio", { name: /AI vs AI/ }));
      expect(seat("White").getByLabelText("API key", { exact: true })).toHaveValue(
        "fixture-White-key",
      );
      expect(seat("White").getByLabelText("API key", { exact: true })).toHaveAttribute(
        "type",
        "password",
      );
      expect(seat("Black").getByLabelText("API key", { exact: true })).toHaveAttribute(
        "type",
        "password",
      );
    },
  );
  it("defaults to AI vs AI and creates identical-model matches with independent keys and parameters", async () => {
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const { fetch } = mount();
    expect(screen.getByRole("radio", { name: /AI vs AI/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Start game" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    const { user, panel: white } = await configure("White");
    await user.click(white.getByText("Advanced parameters"));
    await user.type(white.getByRole("spinbutton", { name: "Temperature" }), "0");
    await configure("Black");
    const black = seat("Black");
    await user.click(black.getByText("Advanced parameters"));
    await user.type(black.getByRole("spinbutton", { name: "Temperature" }), "1.5");
    await user.selectOptions(black.getByRole("combobox", { name: "Reasoning effort" }), "high");
    await user.type(black.getByRole("spinbutton", { name: "Maximum output tokens" }), "256");
    expect(white.getByRole("spinbutton", { name: "Temperature" })).toHaveValue(0);
    expect(white.getByLabelText("API key", { exact: true })).toHaveAttribute("type", "password");
    await user.click(white.getByRole("button", { name: "Show key" }));
    expect(white.getByLabelText("API key", { exact: true })).toHaveAttribute("type", "text");
    expect(black.getByLabelText("API key", { exact: true })).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Start game" }));
    await screen.findByRole("heading", { name: "Game created" });
    expect(creations(fetch)).toEqual([
      {
        mode: "ai_vs_ai",
        white: {
          provider: "openai",
          modelId: "fixture-full",
          parameters: { temperature: 0 },
          catalogId: expect.any(String) as unknown,
        },
        black: {
          provider: "openai",
          modelId: "fixture-full",
          parameters: { temperature: 1.5, reasoningEffort: "high", maxOutputTokens: 256 },
          catalogId: expect.any(String) as unknown,
        },
      },
    ]);
    const discoveries = fetch.mock.calls
      .filter(([input]) => requestPath(input) === "/ai/models")
      .map(([, options]) => JSON.parse(requestBody(options)) as unknown);
    expect(discoveries).toEqual([
      { credential: { provider: "openai", apiKey: "fixture-White-key" } },
      { credential: { provider: "openai", apiKey: "fixture-Black-key" } },
    ]);
    expect(writes).not.toHaveBeenCalled();
    expect(window.location.href + JSON.stringify(window.history.state)).not.toContain(
      "fixture-White-key",
    );
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([input]) => requestPath(input).endsWith("/ai-turn")),
      ).toHaveLength(1),
    );
    const turn = fetch.mock.calls.find(([input]) => requestPath(input).endsWith("/ai-turn"));
    expect(JSON.parse(requestBody(turn?.[1])) as unknown).toMatchObject({
      expectedVersion: 0,
      credential: { provider: "openai", apiKey: "fixture-White-key" },
    });
  });

  it.each(["White", "Black"] as const)(
    "configures an AI opponent with the human playing %s",
    async (color) => {
      const { fetch } = mount();
      const user = userEvent.setup();
      await user.click(screen.getByRole("radio", { name: /AI vs human/ }));
      await user.click(
        within(screen.getByRole("group", { name: "Your color" })).getByRole("radio", {
          name: color,
        }),
      );
      await configure(color === "White" ? "Black" : "White", "anthropic");
      expect(screen.getAllByRole("region", { name: /configuration/ })).toHaveLength(1);
      await user.click(screen.getByRole("button", { name: "Start game" }));
      await screen.findByRole("heading", { name: "Game created" });
      expect(creations(fetch)).toEqual([
        {
          mode: "ai_vs_human",
          humanColor: color.toLowerCase(),
          ai: {
            provider: "anthropic",
            modelId: "fixture-full",
            parameters: {},
            catalogId: expect.any(String) as unknown,
          },
        },
      ]);
      expect(document.title).toBe("AI vs human · Neurochess Arena");
      const turns = () =>
        fetch.mock.calls.filter(([input]) => requestPath(input).endsWith("/ai-turn"));
      if (color === "Black") {
        await waitFor(() => expect(turns()).toHaveLength(1));
        expect(JSON.parse(requestBody(turns()[0]?.[1])) as unknown).toMatchObject({
          credential: { provider: "anthropic" },
        });
      } else expect(turns()).toHaveLength(0);
    },
  );

  it("preserves mode drafts, changes only the selected provider, and clears its key and capabilities", async () => {
    mount();
    const { user } = await configure("White");
    await configure("Black", "anthropic");
    await user.click(screen.getByRole("radio", { name: /AI vs human/ }));
    await configure("Black", "openai", "fixture-opponent");
    await user.click(screen.getByRole("radio", { name: /AI vs AI/ }));
    expect(seat("Black").getByLabelText("API key", { exact: true })).toHaveValue(
      "fixture-Black-key",
    );
    await user.selectOptions(
      seat("White").getByRole("combobox", { name: "Provider" }),
      "anthropic",
    );
    expect(seat("White").getByLabelText("API key", { exact: true })).toHaveValue("");
    expect(seat("White").queryByRole("combobox", { name: "Model" })).not.toBeInTheDocument();
    expect(seat("Black").getByRole("combobox", { name: "Model" })).toHaveValue("Fixture full");
    expect(seat("White").queryByRole("spinbutton")).not.toBeInTheDocument();
  });

  it("renders only supported controls, resets model-dependent values, and distinguishes unsupported capabilities", async () => {
    mount();
    const { user, panel } = await configure("White");
    await user.click(panel.getByText("Advanced parameters"));
    await user.type(panel.getByRole("spinbutton", { name: "Temperature" }), "0.5");
    const picker = panel.getByRole("combobox", { name: "Model" });
    await user.clear(picker);
    await user.type(picker, "tokens");
    await user.keyboard("{Enter}");
    await user.click(panel.getByText("Advanced parameters"));
    expect(panel.queryByRole("spinbutton", { name: "Temperature" })).not.toBeInTheDocument();
    expect(panel.queryByRole("combobox", { name: "Reasoning effort" })).not.toBeInTheDocument();
    expect(panel.getByRole("spinbutton", { name: "Maximum output tokens" })).toHaveValue(null);
    expect(panel.getByText(/Not supported for this model/)).toHaveTextContent(
      "Temperature and Reasoning effort",
    );
    await user.clear(picker);
    await user.type(picker, "basic");
    await user.keyboard("{Enter}");
    expect(panel.getByText(/no advertised optional parameters/)).toBeVisible();
    expect(panel.queryByRole("spinbutton")).not.toBeInTheDocument();
  });

  it("blocks missing discovery, invalid keys, out-of-range tokens and temperatures, and free-text model IDs", async () => {
    const { fetch } = mount();
    const { user, panel } = await configure("White");
    await configure("Black");
    await user.click(panel.getByText("Advanced parameters"));
    const start = screen.getByRole("button", { name: "Start game" });
    for (const [name, value] of [
      ["Temperature", "3"],
      ["Maximum output tokens", "0"],
      ["Maximum output tokens", "1025"],
      ["Maximum output tokens", "16.5"],
    ] as const) {
      const field = panel.getByRole("spinbutton", { name });
      await user.clear(field);
      await user.type(field, value);
      expect(start).toHaveAttribute("aria-disabled", "true");
      fireEvent.submit(start.closest("form")!);
      expect(creations(fetch)).toHaveLength(0);
      await user.clear(field);
    }
    expect(start).toHaveAttribute("aria-disabled", "false");
    await user.type(panel.getByLabelText("API key", { exact: true }), " ");
    expect(panel.getByRole("button", { name: "Load models" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(start).toHaveAttribute("aria-disabled", "true");
    await user.clear(panel.getByLabelText("API key", { exact: true }));
    await user.type(panel.getByLabelText("API key", { exact: true }), "replacement");
    await user.click(panel.getByRole("button", { name: "Load models" }));
    const picker = await panel.findByRole("combobox", { name: "Model" });
    await user.clear(picker);
    await user.type(picker, "unlisted model");
    expect(panel.getByText("No matching models. Try another search.")).toBeVisible();
    expect(start).toHaveAttribute("aria-disabled", "true");
  });

  it.each(["provider_auth", "provider_quota", "provider_timeout", "provider_unavailable"])(
    "shows classified discovery failure %s and supports an explicit retry",
    async (kind) => {
      let failed = true;
      mount((path) =>
        path === "/ai/models" && failed ? jsonResponse({ ok: false, error: { kind } }) : undefined,
      );
      const user = userEvent.setup();
      const panel = seat("White");
      await waitFor(() =>
        expect(panel.getByRole("combobox", { name: "Provider" })).not.toHaveAttribute(
          "aria-disabled",
          "true",
        ),
      );
      await user.selectOptions(panel.getByRole("combobox", { name: "Provider" }), "openai");
      await user.type(panel.getByLabelText("API key", { exact: true }), "fixture-failure-key");
      await user.click(panel.getByRole("button", { name: "Load models" }));
      await waitFor(() =>
        expect(panel.getByRole("button", { name: "Load models" })).not.toHaveAttribute(
          "aria-disabled",
          "true",
        ),
      );
      expect(panel.queryByRole("combobox", { name: "Model" })).not.toBeInTheDocument();
      expect(panel.getByLabelText("API key", { exact: true })).toHaveValue("fixture-failure-key");
      failed = false;
      await user.click(panel.getByRole("button", { name: "Load models" }));
      await panel.findByRole("combobox", { name: "Model" });
    },
  );

  it("shows empty discovery and ignores a late result after the key changes", async () => {
    let finish: (response: Response) => void = () => undefined;
    let delayed = false;
    let signal: AbortSignal | null | undefined;
    mount((path, options) => {
      if (path !== "/ai/models") return undefined;
      if (!delayed) return jsonResponse({ ...catalogResponse(), value: [] });
      signal = options?.signal;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    const user = userEvent.setup();
    const panel = seat("White");
    await waitFor(() =>
      expect(panel.getByRole("combobox", { name: "Provider" })).not.toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
    await user.selectOptions(panel.getByRole("combobox", { name: "Provider" }), "openai");
    await user.type(panel.getByLabelText("API key", { exact: true }), "fixture-key");
    await user.click(panel.getByRole("button", { name: "Load models" }));
    await panel.findByText(/No models are available/);
    delayed = true;
    await user.click(panel.getByRole("button", { name: "Load models" }));
    await panel.findByText("Checking models available to this key…");
    await user.type(panel.getByLabelText("API key", { exact: true }), "-changed");
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(jsonResponse(catalogResponse())));
    expect(panel.queryByRole("combobox", { name: "Model" })).not.toBeInTheDocument();
  });

  it("prevents duplicate starts and presents a competing game without retrying creation", async () => {
    let finish: (response: Response) => void = () => undefined;
    let occupied = false;
    const rediscovered = Promise.withResolvers<Response>();
    const { fetch } = mount((path) =>
      path === "/ai/games"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : path === "/ai/games/unfinished" && occupied
          ? rediscovered.promise
          : undefined,
    );
    await configure("White");
    const { user } = await configure("Black");
    await user.dblClick(screen.getByRole("button", { name: "Start game" }));
    expect(creations(fetch)).toHaveLength(1);
    occupied = true;
    await act(async () => finish(errorResponse("GAME_CONFLICT", 409, snapshot())));
    const returnGame = await screen.findByRole("button", { name: "Return to game" });
    expect(returnGame).toHaveAttribute("aria-disabled", "true");
    await user.click(returnGame);
    expect(
      fetch.mock.calls.some(([input]) => requestPath(input) === `/ai/games/${snapshot().gameId}`),
    ).toBe(false);
    await act(async () => rediscovered.resolve(jsonResponse({ snapshot: snapshot() })));
    expect(returnGame).toHaveAttribute("aria-disabled", "false");
    expect(screen.getByRole("button", { name: "Start game" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(creations(fetch)).toHaveLength(1);
  });

  it("discards page-memory keys on unmount and works when sandbox routes are disabled", async () => {
    const first = mount((path) =>
      path === "/sandbox/games/unfinished" ? errorResponse("NOT_FOUND", 404) : undefined,
    );
    await configure("White");
    first.unmount();
    mount();
    expect(seat("White").getByLabelText("API key", { exact: true })).toHaveValue("");
    expect(seat("Black").getByLabelText("API key", { exact: true })).toHaveValue("");
    await waitFor(() =>
      expect(screen.queryByText(/Opening your guest session/)).not.toBeInTheDocument(),
    );
  });
});
