import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";

import { createAnalysisApi } from "../api/analysis-client";
import type { AiIdentity } from "../api/identity";

import { AnalysisBinding, type AnalysisPosition, type AnalysisSource } from "./analysis-binding";

export function useGameAnalysis<State>(
  source: AnalysisSource<State>,
  select: (state: State) => AnalysisPosition | null,
  authorize: (gameId: string, signal: AbortSignal) => Promise<void>,
  baseUrl: string,
  identity?: AiIdentity,
) {
  const binding = useMemo(
    () =>
      new AnalysisBinding(source, select, {
        api: identity?.intent === "account" ? createAnalysisApi(baseUrl, identity) : undefined,
        signal: identity?.signal,
        authorize,
      }),
    [source, select, authorize, baseUrl, identity],
  );
  useLayoutEffect(() => binding.connect(), [binding]);
  const view = useSyncExternalStore(binding.subscribe, binding.getSnapshot);
  return { view, onRetry: binding.retry, onRetrySave: binding.retryPersistence };
}
