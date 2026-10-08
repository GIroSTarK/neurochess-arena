import type { GameSnapshot, LifecycleCommand } from "@neurochess/contracts";

import { ApiFailure } from "../api/failures";
import { isTerminal } from "../gameplay/snapshot";

import type { AiTurnRunner } from "./ai-turn-runner";
import { matchCommand, type MatchContext } from "./context";
import type { ControllerLease } from "./controller-lease";
import { humanColor } from "./state";

interface CommandServices {
  readonly lease: ControllerLease;
  readonly runner: AiTurnRunner;
  readonly loadInvocations: () => Promise<void>;
}

export class MatchCommands {
  constructor(
    private readonly context: MatchContext,
    private readonly services: CommandServices,
  ) {}

  async resume(signal: AbortSignal) {
    const { api, store, live, adopt } = this.context;
    const command: LifecycleCommand = {
      ...matchCommand(store),
      action: "resume",
      controllerId: this.services.lease.id,
    };
    store.setActivity({ ...store.getActivity(), control: command });
    const snapshot = await api.lifecycle(command, signal);
    if (!live(signal)) return;
    adopt(snapshot);
    store.setActivity({ ...store.getActivity(), control: null });
  }
  async move(move: string) {
    const { store } = this.context;
    if (!store.get().canMove || !store.snapshot().legalMoves.includes(move)) return;
    store.setActivity({ ...store.getActivity(), humanCommand: { ...matchCommand(store), move } });
    await this.sendHumanMove(false);
  }
  async retryMove() {
    const { store } = this.context;
    if (
      !store.getActivity().humanCommand ||
      store.get().busy ||
      store.get().phase !== "uncertain"
    ) {
      return;
    }
    await this.sendHumanMove(true);
  }
  private async sendHumanMove(retry: boolean) {
    const { api, store, live, adopt, fail, accessLost } = this.context;
    const signal = this.context.signal();
    const command = store.getActivity().humanCommand;
    if (!signal || !command) return;
    const flow = store.getFlow();
    if (!flow.details) return;
    store.setFlow({ ...flow, activity: { ...flow.activity, busy: true }, issue: null });
    try {
      const accepted = await api.move(command, signal);
      if (!live(signal) || store.getActivity().humanCommand !== command) return;
      adopt(accepted);
      store.setActivity({ ...store.getActivity(), humanCommand: null });
    } catch (error) {
      if (!live(signal) || store.getActivity().humanCommand !== command) return;
      fail(error);
      if (!live(signal)) return;
      try {
        const current = await api.snapshot(command.gameId, signal);
        if (!live(signal)) return;
        adopt(current);
        // Only a newer revision fences an unacknowledged human command.
        if (current.version > command.expectedVersion) {
          store.setActivity({ ...store.getActivity(), humanCommand: null });
        }
      } catch (readError) {
        if (live(signal)) accessLost(readError);
      }
    } finally {
      if (live(signal)) store.setActivity({ ...store.getActivity(), busy: false });
    }
    if (!live(signal)) return;
    if (retry && !store.getActivity().humanCommand && !isTerminal(store.snapshot())) {
      await this.recover();
    } else this.services.runner.schedule();
  }
  async lifecycle(action: "pause" | "abort" | "resign") {
    const { store } = this.context;
    const state = store.get();
    const snapshot = state.details?.snapshot;
    if (!this.context.signal() || !snapshot || isTerminal(snapshot) || state.busy) return;
    const losingColor = humanColor(state.details);
    if (action === "resign" && (!losingColor || state.phase !== "ready")) return;
    this.services.runner.stop();
    const control: LifecycleCommand =
      action === "resign" && losingColor
        ? { ...matchCommand(store), action: "resign", losingColor }
        : {
            ...matchCommand(store),
            action: action === "abort" ? "abort" : "pause",
            ...(store.getActivity().lease ? { controllerId: this.services.lease.id } : {}),
          };
    store.setActivity({ ...store.getActivity(), control });
    await this.sendControl(false);
  }
  async recover(entrySnapshot?: GameSnapshot) {
    const { api, store, live, adopt, fail } = this.context;
    const signal = this.context.signal();
    if (!signal || store.get().busy || !store.get().details) return;
    this.services.runner.stop();
    this.services.lease.release();
    const flow = store.getFlow();
    if (!flow.details) return;
    store.setFlow({ ...flow, phase: "recovering", activity: { ...flow.activity, busy: true } });
    try {
      const snapshot = entrySnapshot ?? (await api.snapshot(flow.details.snapshot.gameId, signal));
      if (!live(signal)) return;
      adopt(snapshot);
      if (isTerminal(snapshot)) {
        this.clear();
        this.services.runner.cancel();
        return;
      }
      // An uncertain pause is retried verbatim. A conflict proves its old revision cannot commit.
      const control = store.getActivity().control;
      store.setActivity({
        ...store.getActivity(),
        busy: false,
        control:
          control?.action === "pause" ? control : { ...matchCommand(store), action: "pause" },
      });
      await this.sendControl(true);
    } catch (error) {
      if (live(signal)) fail(error);
    } finally {
      if (live(signal)) store.setActivity({ ...store.getActivity(), busy: false });
    }
  }
  async retryControl() {
    const { control, busy } = this.context.store.getActivity();
    if (!control || busy || !this.context.signal()) return;
    await this.sendControl(control.action === "pause" && !("controllerId" in control));
  }
  clear() {
    const { store } = this.context;
    store.setActivity({ ...store.getActivity(), control: null, humanCommand: null });
  }
  private async sendControl(recovery: boolean) {
    const { api, store, live, adopt, fail } = this.context;
    const signal = this.context.signal();
    if (!signal) return;
    store.setActivity({ ...store.getActivity(), busy: true });
    try {
      for (let tries = 0; tries < 3; tries++) {
        const command = store.getActivity().control;
        if (!command) break;
        let control: LifecycleCommand | null;
        try {
          const snapshot = await api.lifecycle(command, signal);
          if (!live(signal)) return;
          adopt(snapshot);
          control =
            recovery && "controllerId" in command && !isTerminal(snapshot)
              ? { ...matchCommand(store), action: "pause" }
              : null;
        } catch (error) {
          if (!live(signal)) return;
          if (!(error instanceof ApiFailure) || !error.currentSnapshot) throw error;
          adopt(error.currentSnapshot);
          if (command.action === "resign") {
            store.setActivity({ ...store.getActivity(), control: null });
            fail(error);
            return;
          }
          control =
            isTerminal(error.currentSnapshot) ||
            (error.currentSnapshot.state === "paused" && !recovery && command.action === "pause")
              ? null
              : recovery
                ? { ...matchCommand(store), action: "pause" }
                : { ...command, ...matchCommand(store) };
        }
        store.setActivity({ ...store.getActivity(), control });
      }
      if (store.getActivity().control) throw new ApiFailure("network");
      this.services.runner.cancel();
      this.clear();
      if (recovery) this.services.lease.renewIdentity();
      const flow = store.getFlow();
      if (!flow.details) return;
      store.setFlow({
        ...flow,
        phase: "ready",
        issue:
          recovery && !isTerminal(flow.details.snapshot)
            ? { kind: "notice", code: "recovered" }
            : null,
      });
      void this.services.loadInvocations();
    } catch (error) {
      if (live(signal)) fail(error);
    } finally {
      if (live(signal)) store.setActivity({ ...store.getActivity(), busy: false });
    }
  }
}
