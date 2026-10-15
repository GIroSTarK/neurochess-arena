import {
  type AiParameters,
  type AiProvider,
  type ChessColor,
  type CredentialMetadata,
  type GameDetails,
  sessionApiKeySchema,
} from "@neurochess/contracts";

import type { AiApi } from "../api/ai-client";
import { ApiFailure, RequestRateLimitFailure } from "../api/failures";
import type { createSessionCredentials } from "../api/session-credentials";
import { isAccessFailure } from "../gameplay/failures";

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
export interface SetupEntry {
  readonly existingGameId: string | null;
  readonly issue: SetupIssue | null;
}

const colors = ["white", "black"] as const;

export class SetupController {
  private state: SetupState = {
    mode: "ai_vs_ai",
    humanColor: "white",
    seats: { white: emptySeat("openai"), black: emptySeat("openai") },
    phase: "checking",
    existingGameId: null,
    issue: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly discovery: Partial<Record<ChessColor, AbortController>> = {};
  private operation: AbortController | null = null;
  private lifetime: AbortController | null = null;
  private bootstrap: Promise<void> | null = null;
  private savedCredentials: readonly CredentialMetadata[] = [];

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

  connect(entry: SetupEntry = { existingGameId: null, issue: null }) {
    this.lifetime = new AbortController();
    window.addEventListener("pagehide", this.clearPage);
    const disconnect = () => {
      this.credentials.signal.removeEventListener("abort", disconnect);
      window.removeEventListener("pagehide", this.clearPage);
      this.cancel();
      this.lifetime = null;
      // The page owner retains keys for the controller accepting a successful handoff.
      if (this.state.phase !== "handed-off") {
        this.clearKeys();
        this.publish({ ...this.state, phase: "checking", existingGameId: null, issue: null });
      }
    };
    this.credentials.signal.addEventListener("abort", disconnect, { once: true });
    if (this.credentials.signal.aborted) disconnect();
    else {
      this.publish({
        ...this.state,
        phase: entry.issue ? "unavailable" : entry.existingGameId ? "conflict" : "editing",
        existingGameId: entry.existingGameId,
        issue: entry.issue,
      });
    }
    return disconnect;
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

  private canEdit(color?: ChessColor) {
    return (
      this.lifetime !== null &&
      this.state.phase === "editing" &&
      (color === undefined || this.state.mode === "ai_vs_ai" || this.state.humanColor !== color)
    );
  }

  setMode(mode: SetupState["mode"]) {
    if (!this.canEdit() || mode === this.state.mode) return;
    this.publish({ ...this.state, mode });
    if (mode === "ai_vs_human") this.clearHumanSeat();
  }

  setHumanColor(humanColor: ChessColor) {
    if (!this.canEdit() || humanColor === this.state.humanColor) return;
    this.publish({ ...this.state, humanColor });
    if (this.state.mode === "ai_vs_human") this.clearHumanSeat();
  }

  private clearHumanSeat() {
    const color = this.state.humanColor;
    this.discovery[color]?.abort();
    this.credentials.remove(color);
    this.seat(
      color,
      emptySeat(this.state.seats[color].provider, this.state.seats[color].keyEpoch + 1),
    );
  }

  setProvider(color: ChessColor, provider: AiProvider) {
    if (!this.canEdit(color) || provider === this.state.seats[color].provider) return;
    this.discovery[color]?.abort();
    this.credentials.remove(color);
    this.seat(color, emptySeat(provider, this.state.seats[color].keyEpoch + 1));
  }

  setKey(color: ChessColor, value: string) {
    if (!this.canEdit(color) || this.state.seats[color].credential !== "session") return;
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

  updateSavedCredentials(credentials: readonly CredentialMetadata[]) {
    this.savedCredentials = credentials;
    this.dropRemovedSelections();
  }

  // Locked phases cannot reset a seat, so editing must repeat this when it resumes.
  private dropRemovedSelections() {
    for (const color of colors) {
      const seat = this.state.seats[color];
      if (
        seat.credential !== "session" &&
        !this.savedCredentials.some(
          (item) => item.credentialId === seat.credential && item.provider === seat.provider,
        )
      ) {
        this.setCredential(color, "session");
        this.seat(color, { issue: { code: "provider_auth" } });
      }
    }
  }

  setCredential(color: ChessColor, credential: string) {
    const seat = this.state.seats[color];
    if (!this.canEdit(color) || seat.credential === credential) return;
    if (
      credential !== "session" &&
      !this.savedCredentials.some(
        (item) => item.credentialId === credential && item.provider === seat.provider,
      )
    ) {
      return;
    }
    this.discovery[color]?.abort();
    this.credentials.remove(color);
    if (credential !== "session") this.credentials.setSaved(color, seat.provider, credential);
    this.seat(color, {
      ...emptySeat(seat.provider, seat.keyEpoch + 1),
      credential,
      keyReady: credential !== "session",
    });
  }

  validateKey(color: ChessColor) {
    if (!this.canEdit(color)) return;
    if (!this.state.seats[color].keyReady) this.seat(color, { issue: { code: "key_format" } });
  }

  setModel(color: ChessColor, modelId: string) {
    if (!this.canEdit(color)) return;
    const seat = this.state.seats[color];
    if (modelId === seat.modelId) return;
    if (seat.discovery !== "loaded" || !seat.models.some((model) => model.id === modelId)) return;
    this.seat(color, { modelId, parameters: emptyParameters() });
  }

  setParameter(color: ChessColor, name: keyof AiParameters, value: string) {
    if (!this.canEdit(color)) return;
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
    if (!this.canEdit(color) || seat.discovery === "loading") return;
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
          ...this.credentials.require(color, seat.provider),
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
      if (isAccessFailure(error) && error.code !== "NOT_FOUND") this.loseAccess();
      else {
        this.seat(color, {
          discovery: "error",
          issue: {
            code: error instanceof RequestRateLimitFailure ? "rate_limited" : "unavailable",
          },
        });
      }
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
      this.dropRemovedSelections();
    } catch (error: unknown) {
      if (isCancelled()) return;
      if (error instanceof ApiFailure && error.code === "UNAUTHORIZED") {
        this.clearKeys();
        this.publish({ ...this.state, phase: "editing", existingGameId: null });
      } else if (isAccessFailure(error) && error.code !== "NOT_FOUND") this.loseAccess();
      else {
        this.publish({
          ...this.state,
          phase: "unavailable",
          issue: {
            code: error instanceof RequestRateLimitFailure ? "rate_limited" : "unavailable",
          },
        });
      }
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
      for (const color of colors) {
        const seat = configuration.seats[color];
        if (seat.type === "ai") this.credentials.require(color, seat.provider);
      }
      await this.ensureGuest();
      if (isCancelled()) return null;
      const game = await this.api.create(configuration, request.signal);
      if (isCancelled()) return null;
      this.publish({ ...this.state, phase: "handed-off" });
      return game;
    } catch (error: unknown) {
      if (isCancelled()) return null;
      if (isAccessFailure(error) && error.code !== "NOT_FOUND") this.loseAccess();
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
        const issue: SetupIssue = {
          code: error instanceof RequestRateLimitFailure ? "rate_limited" : "creation_uncertain",
        };
        this.publish({ ...this.state, phase: "unavailable", issue });
      }
      return null;
    }
  }
}
