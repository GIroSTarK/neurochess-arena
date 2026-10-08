import { isTerminal } from "../gameplay/snapshot";

import type { MatchContext } from "./context";

export class ControllerLease {
  private controllerId = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly context: MatchContext) {}
  get id() {
    return this.controllerId;
  }
  renewIdentity() {
    this.controllerId = crypto.randomUUID();
  }
  release() {
    clearTimeout(this.timer);
    const { store } = this.context;
    store.setActivity({ ...store.getActivity(), lease: false });
  }
  async acquire(signal: AbortSignal) {
    const { api, store, live, adopt } = this.context;
    const snapshot = store.snapshot();
    const accepted = await api.controller(
      {
        gameId: snapshot.gameId,
        controllerId: this.controllerId,
        expectedVersion: snapshot.version,
        action: "acquire",
      },
      signal,
    );
    if (!live(signal)) return false;
    adopt(accepted);
    store.setActivity({ ...store.getActivity(), lease: true });
    this.schedule();
    return true;
  }
  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.beat();
    }, 3000);
  }
  private async beat() {
    const { api, store, live, adopt, fail } = this.context;
    const signal = this.context.signal();
    const snapshot = store.get().details?.snapshot;
    if (!signal || !snapshot || !store.getActivity().lease || isTerminal(snapshot)) return;
    try {
      const accepted = await api.controller(
        {
          gameId: snapshot.gameId,
          controllerId: this.controllerId,
          action: "heartbeat",
        },
        signal,
      );
      if (!live(signal) || !store.getActivity().lease) return;
      adopt(accepted);
      if (store.getActivity().lease) this.schedule();
    } catch (error) {
      if (!live(signal)) return;
      this.release();
      fail(error);
    }
  }
}
