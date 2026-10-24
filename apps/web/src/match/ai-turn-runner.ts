import { matchCommand, type MatchContext } from "./context";
import type { ControllerLease } from "./controller-lease";
import type { SeatCredentials } from "./seat-credentials";
import { matchKeysReady } from "./state";

interface TurnServices {
  readonly lease: ControllerLease;
  readonly seats: SeatCredentials;
  readonly resume: (signal: AbortSignal) => Promise<void>;
  readonly loadInvocations: () => Promise<void>;
}

type AiTurnIntent =
  { readonly kind: "startCreated" } | { readonly kind: "resume" } | { readonly kind: "step" };

export class AiTurnRunner {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private request: AbortController | null = null;
  constructor(
    private readonly context: MatchContext,
    private readonly services: TurnServices,
  ) {}
  stop() {
    clearTimeout(this.timer);
    const { store } = this.context;
    store.setActivity({ ...store.getActivity(), running: false });
  }
  cancel() {
    this.request?.abort();
    this.request = null;
    const { store } = this.context;
    store.setActivity({ ...store.getActivity(), turn: { phase: "idle", command: null } });
  }
  setSpeed(speed: number) {
    if (![500, 1500, 5000].includes(speed)) return;
    const { store } = this.context;
    store.setFlow({ ...store.getFlow(), speed });
    if (store.getActivity().running && store.getActivity().turn.phase === "idle") this.schedule();
  }
  startCreated() {
    return this.run({ kind: "startCreated" });
  }
  resume() {
    return this.run({ kind: "resume" });
  }
  step() {
    return this.run({ kind: "step" });
  }
  private async run(intent: AiTurnIntent) {
    const { store, live, fail } = this.context;
    const signal = this.context.signal();
    const state = store.get();
    const snapshot = state.details?.snapshot;
    const activity = store.getActivity();
    if (
      !signal ||
      !snapshot ||
      state.busy ||
      activity.turn.phase !== "idle" ||
      activity.humanCommand ||
      state.phase !== "ready" ||
      !matchKeysReady(state) ||
      (intent.kind === "step" && state.details.configuration?.seats[snapshot.turn].type !== "ai") ||
      (intent.kind === "startCreated" ? snapshot.state !== "active" : snapshot.state !== "paused")
    ) {
      return;
    }
    const flow = store.getFlow();
    if (!flow.details) return;
    store.setFlow({ ...flow, activity: { ...flow.activity, busy: true }, issue: null });
    let dispatch = false;
    try {
      if (!(await this.services.lease.acquire(signal))) return;
      if (intent.kind === "resume") await this.services.resume(signal);
      if (!live(signal)) return;
      store.setActivity({ ...store.getActivity(), running: intent.kind !== "step" });
      dispatch = true;
    } catch (error) {
      if (live(signal)) fail(error);
    } finally {
      if (live(signal)) store.setActivity({ ...store.getActivity(), busy: false });
    }
    if (dispatch && live(signal)) {
      await this.execute(intent.kind === "step" ? "step" : "continuous");
    }
  }
  schedule() {
    clearTimeout(this.timer);
    const { store } = this.context;
    const { details, phase } = store.get();
    const { running, turn, humanCommand, busy } = store.getActivity();
    if (
      running &&
      turn.phase === "idle" &&
      !humanCommand &&
      !busy &&
      phase === "ready" &&
      details?.configuration?.seats[details.snapshot.turn].type === "ai"
    ) {
      this.timer = setTimeout(() => {
        void this.execute("continuous");
      }, store.get().speed);
    }
  }
  private async execute(mode: "continuous" | "step") {
    const { api, store, live, adopt, fail } = this.context;
    const signal = this.context.signal();
    const { details, phase } = store.get();
    const { lease, turn, humanCommand, busy } = store.getActivity();
    if (
      !signal ||
      !details ||
      !lease ||
      turn.phase !== "idle" ||
      humanCommand ||
      busy ||
      phase !== "ready" ||
      details.snapshot.state !== (mode === "step" ? "paused" : "active")
    ) {
      return;
    }
    const seat = details.configuration?.seats[details.snapshot.turn];
    const credentials = this.services.seats.current;
    if (seat?.type !== "ai" || !credentials) return;
    const command = {
      ...matchCommand(store),
      controllerId: this.services.lease.id,
      step: mode === "step",
    };
    const request = new AbortController();
    this.request = request;
    const flow = store.getFlow();
    if (!flow.details) return;
    store.setFlow({
      ...flow,
      activity: { ...flow.activity, turn: { phase: "thinking", command } },
      issue: null,
    });
    try {
      const accepted = await api.turn(
        command,
        credentials.require(details.snapshot.turn, seat.provider),
        AbortSignal.any([signal, request.signal]),
      );
      if (!live(signal) || this.request !== request) return;
      adopt(accepted);
      this.request = null;
      store.setActivity({ ...store.getActivity(), turn: { phase: "idle", command: null } });
      void this.services.loadInvocations();
      this.schedule();
    } catch (error) {
      if (!live(signal) || this.request !== request) return;
      this.stop();
      // Keep the original identity until a newer revision or a versioned pause fences it.
      store.setActivity({ ...store.getActivity(), turn: { phase: "uncertain", command } });
      fail(error);
    }
  }
}
