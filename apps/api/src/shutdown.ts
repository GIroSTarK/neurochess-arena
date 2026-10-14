interface ShutdownOptions {
  closeServer(): Promise<unknown>;
  closeDatabase(): Promise<unknown>;
  onTimeout(): void;
  timeoutMs?: number;
}

export function createShutdown(options: ShutdownOptions): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= (async () => {
      // Allow the 180-second provider scope and queued SMTP work to drain before
      // the supervisor's 220-second stop deadline. Never start a second owner.
      const deadline = setTimeout(() => options.onTimeout(), options.timeoutMs ?? 210_000);
      deadline.unref();
      try {
        try {
          await options.closeServer();
        } finally {
          await options.closeDatabase();
        }
      } finally {
        clearTimeout(deadline);
      }
    })();
    return closing;
  };
}
