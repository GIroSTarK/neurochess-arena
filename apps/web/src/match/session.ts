import type { GameDetails, GameSnapshot } from "@neurochess/contracts";

import { AiRequestFailure } from "../api/ai-client";
import { ApiFailure } from "../api/failures";
import { parseGameId } from "../app/route-urls";
import type { ArchiveController } from "../gameplay/archive";
import { isAccessFailure } from "../gameplay/failures";
import { isTerminal } from "../gameplay/snapshot";

import type { AiTurnRunner } from "./ai-turn-runner";
import type { MatchCommands } from "./commands";
import type { ControllerLease } from "./controller-lease";
import type { InvocationFeed } from "./invocation-feed";
import type { SeatCredentials, SessionCredentials } from "./seat-credentials";
import { idleActivity } from "./state";
import type { MatchStore } from "./store";

export type MatchEntry =
  | { readonly kind: "setup" }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable"; readonly code: "access" | "unavailable" }
  | { readonly kind: "game"; readonly gameId: string; readonly details: GameDetails };

export interface MatchNavigation {
  game(gameId: string, reason: "created" | "recovered"): void;
  setup(): void;
}

interface SessionServices {
  readonly archive: ArchiveController;
  readonly lease: ControllerLease;
  readonly runner: AiTurnRunner;
  readonly commands: MatchCommands;
  readonly invocations: InvocationFeed;
  readonly seats: SeatCredentials;
  readonly createCredentials: (signal: AbortSignal) => SessionCredentials;
}

export class MatchSession {
  private lifetime: AbortController | null = null;
  constructor(
    private readonly store: MatchStore,
    private readonly services: SessionServices,
    private readonly navigation?: MatchNavigation,
  ) {}
  signal() {
    return this.lifetime?.signal ?? null;
  }
  live(signal: AbortSignal) {
    return !signal.aborted && this.lifetime !== null;
  }
  endLifetime() {
    if (!this.lifetime) return;
    this.lifetime.abort();
    this.lifetime = null;
    const { runner, invocations, lease, archive, seats } = this.services;
    seats.close();
    this.store.reset();
    runner.stop();
    runner.cancel();
    lease.release();
    invocations.cancel();
    archive.cancel();
  }
  async enter(entry: MatchEntry): Promise<void> {
    this.endLifetime();
    this.lifetime = new AbortController();
    const signal = this.lifetime.signal;
    this.services.seats.open(this.services.createCredentials(signal));
    this.services.lease.renewIdentity();
    const id = entry.kind === "game" ? parseGameId(entry.gameId) : null;
    const empty = {
      details: null,
      activity: idleActivity,
      speed: this.store.get().speed,
      issue: null,
      startedGameId: null,
    } as const;
    if (entry.kind === "setup") {
      this.store.setFlow({ ...empty, phase: "setup" });
      return;
    }
    if (!id || entry.kind !== "game") {
      this.store.setFlow({
        ...empty,
        phase: "unavailable",
        issue: { kind: "notice", code: entry.kind === "unavailable" ? entry.code : "access" },
      });
      return;
    }
    this.store.setFlow({ ...empty, phase: "loading" });
    try {
      // Seeded entries also yield so a discarded mount cannot begin recovery writes.
      const details = await Promise.resolve(entry.details);
      if (!this.live(signal)) return;
      if (parseGameId(details.snapshot.gameId) !== id) throw new ApiFailure("malformed");
      this.store.setFlow({ ...empty, details, phase: "ready" });
      this.navigation?.game(id, "recovered");
      if (!this.live(signal)) return;
      void this.services.invocations.load();
      if (isTerminal(details.snapshot)) await this.loadReplay();
      else if (details.configuration) await this.services.commands.recover(details.snapshot);
    } catch (error) {
      if (this.live(signal)) this.fail(error, "unavailable");
    }
  }
  async created(details: GameDetails) {
    const flow = this.store.getFlow();
    if (!this.lifetime || flow.activity.busy || flow.phase !== "setup") return;
    this.services.invocations.clear();
    this.store.setFlow({
      ...flow,
      details,
      phase: "ready",
      startedGameId: details.snapshot.gameId,
      issue: null,
    });
    this.services.seats.refresh();
    const signal = this.lifetime.signal;
    this.navigation?.game(details.snapshot.gameId, "created");
    if (!this.live(signal)) return;
    void this.services.invocations.load();
    await this.services.runner.continue(false, true);
  }
  adopt(snapshot: GameSnapshot) {
    const flow = this.store.getFlow();
    if (flow.details === null) return;
    if (
      snapshot.gameId !== flow.details.snapshot.gameId ||
      snapshot.version < flow.details.snapshot.version
    ) {
      return;
    }
    const changed = snapshot.version !== flow.details.snapshot.version;
    const { invocations, archive, runner, lease } = this.services;
    if (changed) {
      invocations.cancel();
      archive.cancel();
    }
    const terminal = isTerminal(snapshot);
    this.store.setFlow({
      ...flow,
      details: { ...flow.details, snapshot },
      activity: {
        ...flow.activity,
        running: snapshot.state === "active" && flow.activity.running,
        lease: !terminal && flow.activity.lease,
      },
      phase: terminal ? "ready" : flow.phase,
      issue: terminal ? null : flow.issue,
    });
    if (changed) void invocations.load();
    if (snapshot.state !== "active") runner.stop();
    if (terminal) {
      lease.release();
      void this.loadReplay();
    }
  }
  accessLost(error: unknown) {
    if (!isAccessFailure(error)) return false;
    this.endLifetime();
    this.store.setFlow({
      phase: "unavailable",
      details: null,
      activity: idleActivity,
      speed: this.store.get().speed,
      startedGameId: null,
      issue: { kind: "notice", code: "access" },
    });
    return true;
  }
  fail(error: unknown, phase: "uncertain" | "unavailable" = "uncertain") {
    this.services.runner.stop();
    this.services.lease.release();
    if (this.accessLost(error)) return;
    if (error instanceof ApiFailure && error.currentSnapshot) {
      this.adopt(error.currentSnapshot);
      if (isTerminal(error.currentSnapshot)) {
        this.services.runner.cancel();
        this.services.commands.clear();
        const flow = this.store.getFlow();
        if (flow.details) this.store.setFlow({ ...flow, phase: "ready", issue: null });
        return;
      }
    }
    const flow = this.store.getFlow();
    const issue =
      error instanceof AiRequestFailure
        ? ({ kind: "request", code: error.code } as const)
        : ({ kind: "notice", code: phase } as const);
    this.store.setFlow(
      flow.details && phase === "uncertain"
        ? { ...flow, phase, issue }
        : {
            phase: "unavailable",
            details: null,
            activity: idleActivity,
            startedGameId: null,
            speed: flow.speed,
            issue,
          },
    );
  }
  async loadReplay() {
    if (!this.store.get().replay) await this.services.archive.loadReplay();
  }
  newGame() {
    const details = this.store.get().details;
    if (details && !isTerminal(details.snapshot)) return;
    this.endLifetime();
    this.navigation?.setup();
  }
}
