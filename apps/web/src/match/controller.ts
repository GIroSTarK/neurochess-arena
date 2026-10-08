import type {
  ChessColor,
  CredentialMetadata,
  GameDetails,
  GameSnapshot,
} from "@neurochess/contracts";

import type { AiApi } from "../api/ai-client";
import { createSessionCredentials } from "../api/session-credentials";
import { ArchiveController } from "../gameplay/archive";
import { browserPgnDelivery, type PgnDelivery } from "../gameplay/pgn";

import { AiTurnRunner } from "./ai-turn-runner";
import { MatchCommands } from "./commands";
import type { MatchContext } from "./context";
import { ControllerLease } from "./controller-lease";
import { InvocationFeed } from "./invocation-feed";
import { SeatCredentials } from "./seat-credentials";
import { type MatchEntry, type MatchNavigation, MatchSession } from "./session";
import { MatchStore } from "./store";

export type { MatchEntry, MatchNavigation } from "./session";
export { humanColor, type MatchIssue, matchKeysReady, type MatchState } from "./state";

export class MatchController {
  private readonly store = new MatchStore();
  private readonly seats = new SeatCredentials(this.store);
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
    const context: MatchContext = {
      api,
      store: this.store,
      signal: () => this.session.signal(),
      live: (signal) => this.session.live(signal),
      adopt: (snapshot) => this.session.adopt(snapshot),
      fail: (error) => this.session.fail(error),
      accessLost: (error) => this.session.accessLost(error),
    };
    const lease = new ControllerLease(context);
    this.invocations = new InvocationFeed(context);
    const loadInvocations = () => this.invocations.load();
    this.runner = new AiTurnRunner(context, {
      lease,
      seats: this.seats,
      resume: (signal) => this.commands.resume(signal),
      loadInvocations,
    });
    this.commands = new MatchCommands(context, { lease, runner: this.runner, loadInvocations });
    this.archive = new ArchiveController({
      api,
      delivery,
      store: {
        get: () => this.store.getArchive(),
        setReplay: (state) => this.store.setReplay(state),
        setExport: (state) => this.store.setExport(state),
      },
      isConnected: () => this.session.signal() !== null,
      loseAccess: context.accessLost,
    });
    this.session = new MatchSession(
      this.store,
      {
        archive: this.archive,
        lease,
        runner: this.runner,
        commands: this.commands,
        invocations: this.invocations,
        seats: this.seats,
        createCredentials: createSessionCredentials,
      },
      navigation,
    );
  }

  readonly getSnapshot = () => this.store.get();
  readonly subscribe = (listener: () => void) => this.store.subscribe(listener);
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
  continue(step: boolean, created = false) {
    return this.runner.continue(step, created);
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
