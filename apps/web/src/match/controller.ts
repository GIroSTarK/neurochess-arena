import type {
  ChessColor,
  CredentialMetadata,
  GameDetails,
  GameSnapshot,
} from "@neurochess/contracts";

import type { AiApi } from "../api/ai-client";
import { createSessionCredentials } from "../api/session-credentials";
import type { ArchiveController } from "../gameplay/archive";
import { browserPgnDelivery, type PgnDelivery } from "../gameplay/pgn";

import type { AiTurnRunner } from "./ai-turn-runner";
import type { MatchCommands } from "./commands";
import { createMatchComposition } from "./composition";
import type { InvocationFeed } from "./invocation-feed";
import type { SeatCredentials } from "./seat-credentials";
import type { MatchEntry, MatchNavigation, MatchSession } from "./session";
import type { MatchStore } from "./store";

export type { MatchEntry, MatchNavigation } from "./session";
export { humanColor, type MatchIssue, matchKeysReady, type MatchState } from "./state";

export class MatchController {
  private readonly store: MatchStore;
  private readonly seats: SeatCredentials;
  private readonly session: MatchSession;
  private readonly runner: AiTurnRunner;
  private readonly commands: MatchCommands;
  private readonly invocations: InvocationFeed;
  private readonly archive: ArchiveController;

  constructor(
    readonly api: AiApi,
    delivery: PgnDelivery = browserPgnDelivery,
    navigation?: MatchNavigation,
  ) {
    const composition = createMatchComposition({
      api,
      delivery,
      createCredentials: createSessionCredentials,
      navigation,
    });
    this.store = composition.store;
    this.seats = composition.seats;
    this.session = composition.session;
    this.runner = composition.runner;
    this.commands = composition.commands;
    this.invocations = composition.invocations;
    this.archive = composition.archive;
  }

  readonly getSnapshot = () => this.store.get();
  readonly subscribe = (listener: () => void) => this.store.subscribe(listener);
  readonly authorizeAnalysis = async (gameId: string, signal: AbortSignal) => {
    try {
      await this.api.snapshot(gameId, signal);
    } catch (error) {
      if (!signal.aborted) this.session.accessLost(error);
      throw error;
    }
  };
  get credentials() {
    return this.seats.current;
  }

  enter(entry: MatchEntry) {
    return this.session.enter(entry);
  }
  created(details: GameDetails) {
    return this.session.created(details);
  }
  endLifetime() {
    this.session.endLifetime();
  }
  newGame() {
    this.session.newGame();
  }

  setKey(color: ChessColor, value: string) {
    this.seats.setKey(color, value);
  }
  setCredential(color: ChessColor, credential: string, saved: readonly CredentialMetadata[]) {
    this.seats.setCredential(color, credential, saved);
  }
  reconcileSavedCredentials(saved: readonly CredentialMetadata[]) {
    this.seats.reconcile(saved);
  }

  setSpeed(speed: number) {
    this.runner.setSpeed(speed);
  }
  resume() {
    return this.runner.resume();
  }
  step() {
    return this.runner.step();
  }
  move(move: string) {
    return this.commands.move(move);
  }
  retryMove() {
    return this.commands.retryMove();
  }
  lifecycle(action: "pause" | "abort" | "resign") {
    return this.commands.lifecycle(action);
  }
  recover(entrySnapshot?: GameSnapshot) {
    return this.commands.recover(entrySnapshot);
  }
  retryControl() {
    return this.commands.retryControl();
  }
  canMove() {
    return this.store.get().canMove;
  }
  hasPendingMove() {
    return this.store.get().pendingMove;
  }
  hasPendingControl() {
    return this.store.get().pendingControl;
  }

  loadInvocations() {
    return this.invocations.load();
  }
  loadReplay() {
    return this.session.loadReplay();
  }
  selectPly(ply: number) {
    this.archive.selectPly(ply);
  }
  exportPgn(kind: "copy" | "download") {
    return this.archive.exportPgn(kind);
  }
}
