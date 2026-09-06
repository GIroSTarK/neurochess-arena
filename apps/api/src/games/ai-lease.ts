import {
  AiPersistenceError,
  type AiReservationOwner,
  type GameRepository,
} from "@neurochess/database";

export function assertAiExecutionAttached(signal: AbortSignal): void {
  if (signal.aborted) throw new AiPersistenceError("RESERVATION_LOST");
}

export async function withAiLease<T>(
  repository: GameRepository,
  owner: AiReservationOwner,
  leaseMs: number,
  attached: AbortSignal | undefined,
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const lost = Promise.withResolvers<never>();
  let renewal: Promise<void> | undefined;
  const stop = () => {
    controller.abort();
    lost.reject(new AiPersistenceError("RESERVATION_LOST"));
  };
  attached?.addEventListener("abort", stop, { once: true });
  if (attached?.aborted) stop();
  // Renewal only maintains this attached execution; expiry never grants another executor rights.
  const timer = setInterval(
    () => {
      if (renewal || controller.signal.aborted) return;
      renewal = repository
        .write((tx) => tx.renewAiTurn(owner, leaseMs))
        .catch(stop)
        .finally(() => {
          renewal = undefined;
        });
    },
    Math.max(1, Math.floor(leaseMs / 3)),
  );
  timer.unref();
  try {
    return await Promise.race([execute(controller.signal), lost.promise]);
  } finally {
    clearInterval(timer);
    attached?.removeEventListener("abort", stop);
    controller.abort();
    await renewal;
  }
}
