import { ApiFailure, RequestRateLimitFailure } from "../api/failures";
import { isTerminal } from "../gameplay/snapshot";

import type { MatchContext } from "./context";
import { emptyInvocations } from "./state";

export class InvocationFeed {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private request: AbortController | null = null;
  constructor(private readonly context: MatchContext) {}
  cancel() {
    clearTimeout(this.timer);
    this.request?.abort();
    this.request = null;
  }
  clear() {
    this.cancel();
    this.context.store.setInvocations(emptyInvocations);
  }
  async load() {
    const { api, store, live, adopt, accessLost } = this.context;
    const lifetime = this.context.signal();
    const details = store.get().details;
    if (!lifetime || !details?.configuration || this.request) return;
    const snapshot = details.snapshot;
    clearTimeout(this.timer);
    const request = new AbortController();
    this.request = request;
    const signal = AbortSignal.any([lifetime, request.signal]);
    const current = () =>
      live(signal) &&
      this.request === request &&
      store.get().details?.snapshot.gameId === snapshot.gameId &&
      store.get().details?.snapshot.version === snapshot.version;
    store.setInvocations({ ...store.getInvocations(), phase: "loading" });
    let nextPollMs = 3000;
    try {
      const records = await api.invocations(snapshot.gameId, signal);
      if (!current()) return;
      if (records.gameId !== snapshot.gameId || records.version < snapshot.version) {
        throw new ApiFailure("malformed");
      }
      if (records.version > snapshot.version) {
        const latest = await api.snapshot(snapshot.gameId, signal);
        if (!current()) return;
        adopt(latest);
        return;
      }
      // Totals describe the history at this read, even while the next revision is loading.
      store.setInvocations({ phase: "loading", records, moveCount: snapshot.moves.length });
      const turn = records.turns.at(-1);
      const attempt = turn?.attempts.at(-1);
      const error = attempt?.error;
      const flow = store.getFlow();
      if (
        snapshot.state === "paused" &&
        flow.phase === "ready" &&
        !flow.activity.busy &&
        flow.activity.turn.phase !== "thinking" &&
        turn?.ply === snapshot.moves.length + 1 &&
        attempt?.outcome === "provider_error" &&
        error &&
        error.code !== "model_invalid"
      ) {
        store.setFlow({ ...flow, issue: { kind: "provider", color: turn.color, error } });
      }
    } catch (error) {
      if (error instanceof RequestRateLimitFailure) {
        nextPollMs = Math.max(nextPollMs, error.retryAfterSeconds * 1000);
      }
      if (current() && !accessLost(error)) {
        store.setInvocations({ ...store.getInvocations(), phase: "error" });
      }
    } finally {
      if (current()) {
        this.request = null;
        const state = store.getInvocations();
        store.setInvocations({ ...state, phase: state.phase === "error" ? "error" : "idle" });
        // Attempts can finish without a chess revision; reads never authorize another turn.
        if (!isTerminal(snapshot)) {
          this.timer = setTimeout(() => {
            void this.load();
          }, nextPollMs);
        }
      }
    }
  }
}
