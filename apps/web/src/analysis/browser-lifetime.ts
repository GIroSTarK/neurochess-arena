import type { AnalysisScheduler } from "./scheduler";

export function bindAnalysisLifetime(
  scheduler: Pick<AnalysisScheduler, "suspend" | "resume" | "dispose">,
  options: {
    readonly signal: AbortSignal;
    readonly reauthorize: (signal: AbortSignal) => Promise<boolean>;
  },
): () => void {
  let ended = false;
  const visibility = () => {
    if (document.visibilityState === "hidden") scheduler.suspend();
    else void scheduler.resume(options.reauthorize);
  };
  const end = () => {
    if (ended) return;
    ended = true;
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("pagehide", end);
    options.signal.removeEventListener("abort", end);
    scheduler.dispose();
  };
  if (options.signal.aborted) end();
  else {
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", end);
    options.signal.addEventListener("abort", end, { once: true });
    if (document.visibilityState === "hidden") scheduler.suspend();
  }
  return end;
}
