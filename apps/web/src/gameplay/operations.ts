export interface Operation {
  readonly generation: number;
  readonly abort: AbortController;
}

/**
 * Serializes mutating operations: creation, commands, and recovery. At most one
 * runs at a time, and its response is applied only while it is still current, meaning the gate
 * is connected, nothing has invalidated it since, and its request was not aborted.
 */
export class OperationGate {
  private generation = 0;
  private operation: Operation | null = null;
  private connected = true;

  isConnected(): boolean {
    return this.connected;
  }

  connect(): void {
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
    this.invalidate();
  }

  /** Cancels the running operation and makes every earlier operation stale. */
  invalidate(): void {
    this.generation += 1;
    this.operation?.abort.abort();
    this.operation = null;
  }

  /** Acquired synchronously, so a duplicate activation cannot start a second operation. */
  begin(): Operation | null {
    if (!this.connected || this.operation) return null;
    const operation = { generation: ++this.generation, abort: new AbortController() };
    this.operation = operation;
    return operation;
  }

  isCurrent(operation: Operation): boolean {
    return (
      this.connected && operation.generation === this.generation && !operation.abort.signal.aborted
    );
  }

  finish(operation: Operation): void {
    if (this.isCurrent(operation)) this.operation = null;
  }
}
