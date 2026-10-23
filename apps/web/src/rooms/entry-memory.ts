import type { RoomView } from "@neurochess/contracts";

export type RoomIssue =
  | "invalid"
  | "unavailable"
  | "occupied"
  | "access"
  | "unverified"
  | "self"
  | "limited"
  | "operation"
  | "uncertain";
export interface RoomEntryState {
  readonly input: string;
  readonly issuedInvitation: string | null;
  readonly resolution: "joinable" | "unavailable" | null;
  readonly room: RoomView | null;
  readonly busy: boolean;
  readonly pending: "create" | "join" | null;
  readonly issue: RoomIssue | null;
}
const empty: RoomEntryState = {
  input: "",
  issuedInvitation: null,
  resolution: null,
  room: null,
  busy: false,
  pending: null,
  issue: null,
};

// Secrets deliberately live outside router loader/action/fetcher results and form submissions.
export class RoomEntryMemory {
  private state: RoomEntryState;
  private lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  constructor(invitation: string | null) {
    this.state = { ...empty, input: invitation ?? "" };
  }
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get signal() {
    return this.lifetime.signal;
  }
  update(update: Partial<RoomEntryState>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((listener) => listener());
  }
  setInput(input: string) {
    if (this.state.busy || this.state.pending) return;
    this.update({ input: input.slice(0, 1024), resolution: null, issue: null });
  }
  clear() {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.state = { ...empty };
    this.listeners.forEach((listener) => listener());
  }
}
