/** Immutable state with change notification, shaped for `useSyncExternalStore`. */
export class Store<State extends object> {
  private readonly listeners = new Set<() => void>();

  constructor(private state: State) {}

  readonly get = (): State => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  patch(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
