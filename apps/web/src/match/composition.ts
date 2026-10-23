import type { AiApi } from "../api/ai-client";
import { ArchiveController } from "../gameplay/archive";
import type { PgnDelivery } from "../gameplay/pgn";

import { AiTurnRunner } from "./ai-turn-runner";
import { MatchCommands } from "./commands";
import type { MatchContext } from "./context";
import { ControllerLease } from "./controller-lease";
import { InvocationFeed } from "./invocation-feed";
import { SeatCredentials, type SessionCredentials } from "./seat-credentials";
import { type MatchNavigation, MatchSession } from "./session";
import { MatchStore } from "./store";

interface MatchCompositionOptions {
  readonly api: AiApi;
  readonly delivery: PgnDelivery;
  readonly createCredentials: (signal: AbortSignal) => SessionCredentials;
  readonly navigation?: MatchNavigation | undefined;
}

export function createMatchComposition({
  api,
  delivery,
  createCredentials,
  navigation,
}: MatchCompositionOptions) {
  const store = new MatchStore();
  const seats = new SeatCredentials(store);
  // Constructors only wire dependencies; callbacks run after the graph is complete.
  const context: MatchContext = {
    api,
    store,
    signal: () => session.signal(),
    live: (signal) => session.live(signal),
    adopt: (snapshot) => session.adopt(snapshot),
    fail: (error) => session.fail(error),
    accessLost: (error) => session.accessLost(error),
  };
  const lease = new ControllerLease(context);
  const invocations = new InvocationFeed(context);
  const loadInvocations = () => invocations.load();
  const runner: AiTurnRunner = new AiTurnRunner(context, {
    lease,
    seats,
    resume: (signal) => commands.resume(signal),
    loadInvocations,
  });
  const commands: MatchCommands = new MatchCommands(context, { lease, runner, loadInvocations });
  const archive = new ArchiveController({
    api,
    delivery,
    store: {
      get: () => store.getArchive(),
      setReplay: (state) => store.setReplay(state),
      setExport: (state) => store.setExport(state),
    },
    isConnected: () => session.signal() !== null,
    loseAccess: context.accessLost,
  });
  const session: MatchSession = new MatchSession(
    store,
    { archive, lease, runner, commands, invocations, seats, createCredentials },
    navigation,
  );
  return { store, seats, lease, invocations, runner, commands, archive, session };
}
