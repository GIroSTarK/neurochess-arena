import {
  type AiParameters,
  type AiProvider,
  type ChessColor,
  type GameDetails,
  sessionApiKeySchema,
} from "@neurochess/contracts";

import type { AiApi } from "../api/ai-client";
import { ApiFailure } from "../api/failures";
import type { createSessionCredentials } from "../api/session-credentials";

import {
  emptyParameters,
  emptySeat,
  selectedModel,
  setupConfiguration,
  type SetupIssue,
  type SetupState,
} from "./state";

export type SetupApi = Pick<AiApi, "bootstrap" | "discover" | "create" | "unfinished">;
export type SetupCredentials = ReturnType<typeof createSessionCredentials>;

const colors = ["white", "black"] as const;
const accessLost = (error: unknown) =>
  error instanceof ApiFailure && (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN");

export class SetupController {
  private state: SetupState = {
    seats: { white: emptySeat("openai"), black: emptySeat("anthropic") },
    phase: "checking",
    existingGameId: null,
    issue: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly discovery: Partial<Record<ChessColor, AbortController>> = {};
  private operation: AbortController | null = null;
  private lifetime: AbortController | null = null;
  private bootstrap: Promise<void> | null = null;

  constructor(
    private readonly api: SetupApi,
    private readonly credentials: SetupCredentials,
  ) {}

  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(state: SetupState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }

  private seat(color: ChessColor, update: Partial<SetupState["seats"][ChessColor]>) {
    this.publish({
      ...this.state,
      seats: {
        ...this.state.seats,
        [color]: { ...this.state.seats[color], ...update },
      },
    });
  }

  connect() {
    this.lifetime = new AbortController();
    window.addEventListener("pagehide", this.clearPage);
    void this.checkExisting();
    return () => {
      window.removeEventListener("pagehide", this.clearPage);
      this.cancel();
      this.lifetime = null;
      // The page owner retains keys for the controller accepting a successful handoff.
      if (this.state.phase !== "handed-off") {
        this.clearKeys();
        this.publish({ ...this.state, phase: "checking", existingGameId: null, issue: null });
      }
    };
  }

  private cancel() {
    this.lifetime?.abort();
    this.operation?.abort();
    for (const color of colors) this.discovery[color]?.abort();
    this.bootstrap = null;
  }

  private clearKeys() {
    this.credentials.clear();
    const seats = { ...this.state.seats };
    for (const color of colors) {
      seats[color] = emptySeat(seats[color].provider, seats[color].keyEpoch + 1);
    }
    this.publish({ ...this.state, seats });
  }

  private readonly clearPage = () => {
    this.cancel();
    this.clearKeys();
    this.lifetime = new AbortController();
    this.publish({ ...this.state, phase: "unavailable", issue: { code: "unavailable" } });
  };

  private canEdit() {
    return this.lifetime !== null && this.state.phase === "editing";
  }

  setProvider(color: ChessColor, provider: AiProvider) {
    if (!this.canEdit() || provider === this.state.seats[color].provider) return;
    this.discovery[color]?.abort();
    this.credentials.remove(color);
    this.seat(color, emptySeat(provider, this.state.seats[color].keyEpoch + 1));
  }

  setKey(color: ChessColor, value: string) {
    if (!this.canEdit()) return;
    this.discovery[color]?.abort();
    const seat = this.state.seats[color];
    const parsed = sessionApiKeySchema.safeParse(value);
    this.credentials.remove(color);
    if (parsed.success) this.credentials.set(color, seat.provider, parsed.data);
    this.seat(color, {
      ...emptySeat(seat.provider, seat.keyEpoch),
      keyReady: parsed.success,
    });
  }

  validateKey(color: ChessColor) {
    if (!this.canEdit()) return;
    if (!this.state.seats[color].keyReady) this.seat(color, { issue: { code: "key_format" } });
  }

  setModel(color: ChessColor, modelId: string) {
    if (!this.canEdit()) return;
    const seat = this.state.seats[color];
    if (modelId === seat.modelId) return;
    if (seat.discovery !== "loaded" || !seat.models.some((model) => model.id === modelId)) return;
    this.seat(color, { modelId, parameters: emptyParameters() });
  }

  setParameter(color: ChessColor, name: keyof AiParameters, value: string) {
    if (!this.canEdit()) return;
    const seat = this.state.seats[color];
    if (!selectedModel(seat)?.capabilities.parameters[name]) return;
    this.seat(color, { parameters: { ...seat.parameters, [name]: value } });
  }

  private ensureGuest(): Promise<void> {
    const lifetime = this.lifetime;
    if (!lifetime || lifetime.signal.aborted) return Promise.reject(new ApiFailure("cancelled"));
    // Two explicit seat discoveries can share bootstrap, but never each other's catalog or key.
    if (!this.bootstrap) {
      const pending = this.api.bootstrap(lifetime.signal).finally(() => {
        if (this.bootstrap === pending) this.bootstrap = null;
      });
      this.bootstrap = pending;
    }
    return this.bootstrap;
  }

  async discover(color: ChessColor): Promise<void> {
    const seat = this.state.seats[color];
    if (!this.canEdit() || seat.discovery === "loading") return;
    if (!seat.keyReady) {
      this.validateKey(color);
      return;
    }
    const request = new AbortController();
    const isCancelled = () => request.signal.aborted;
    this.discovery[color]?.abort();
    this.discovery[color] = request;
    this.seat(color, {
      discovery: "loading",
      models: [],
      modelId: "",
      parameters: emptyParameters(),
      issue: null,
    });
    try {
      await this.ensureGuest();
      if (isCancelled()) return;
      const result = await this.api.discover(
        {
          provider: seat.provider,
          apiKey: this.credentials.require(color, seat.provider),
        },
        request.signal,
      );
      if (isCancelled()) return;
      if (!result.ok) {
        this.seat(color, { discovery: "error", issue: result.error });
      } else if (result.models.some((model) => model.provider !== seat.provider)) {
        this.seat(color, { discovery: "error", issue: { code: "unavailable" } });
      } else {
        this.seat(color, { discovery: "loaded", models: result.models });
      }
    } catch (error: unknown) {
      if (isCancelled()) return;
      if (accessLost(error)) this.loseAccess();
      else this.seat(color, { discovery: "error", issue: { code: "unavailable" } });
    }
  }

  private loseAccess() {
    this.cancel();
    this.clearKeys();
    this.lifetime = new AbortController();
    this.publish({
      ...this.state,
      phase: "unavailable",
      existingGameId: null,
      issue: { code: "access" },
    });
  }

  async checkExisting(): Promise<void> {
    if (!this.lifetime || this.state.phase === "creating" || this.state.phase === "handed-off") {
      return;
    }
    this.operation?.abort();
    const request = new AbortController();
    const isCancelled = () => request.signal.aborted;
    this.operation = request;
    this.publish({ ...this.state, phase: "checking", issue: null });
    try {
      const game = await this.api.unfinished(request.signal);
      if (isCancelled()) return;
      this.publish({
        ...this.state,
        phase: game ? "conflict" : "editing",
        existingGameId: game?.snapshot.gameId ?? null,
      });
    } catch (error: unknown) {
      if (isCancelled()) return;
      if (error instanceof ApiFailure && error.code === "UNAUTHORIZED") {
        this.clearKeys();
        this.publish({ ...this.state, phase: "editing", existingGameId: null });
      } else if (accessLost(error)) this.loseAccess();
      else this.publish({ ...this.state, phase: "unavailable", issue: { code: "unavailable" } });
    }
  }

  async start(): Promise<GameDetails | null> {
    const configuration = setupConfiguration(this.state);
    if (!this.canEdit() || !configuration) return null;
    const request = new AbortController();
    const isCancelled = () => request.signal.aborted;
    this.operation = request;
    this.publish({ ...this.state, phase: "creating", issue: null });
    try {
      // Recheck key ownership before creating. Keys never enter the configuration or handoff.
      for (const color of colors) this.credentials.require(color, this.state.seats[color].provider);
      await this.ensureGuest();
      if (isCancelled()) return null;
      const game = await this.api.create(configuration, request.signal);
      if (isCancelled()) return null;
      this.publish({ ...this.state, phase: "handed-off" });
      return game;
    } catch (error: unknown) {
      if (isCancelled()) return null;
      if (accessLost(error)) this.loseAccess();
      else if (
        error instanceof ApiFailure &&
        error.code === "GAME_CONFLICT" &&
        error.currentSnapshot
      ) {
        this.publish({
          ...this.state,
          phase: "conflict",
          existingGameId: error.currentSnapshot.gameId,
        });
      } else {
        // Creation has no receipt ID. Require a read and another explicit action after a lost reply.
        const issue: SetupIssue = { code: "creation_uncertain" };
        this.publish({ ...this.state, phase: "unavailable", issue });
      }
      return null;
    }
  }
}
