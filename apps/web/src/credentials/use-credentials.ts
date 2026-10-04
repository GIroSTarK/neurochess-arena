import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { useFetcher } from "react-router";

import type { AiIdentity } from "../api/ai-client";

import { type CredentialCatalogState, observeCredentialChanges } from "./catalog";
import type { CredentialRouteData } from "./route-data";

const empty: CredentialCatalogState = { phase: "loading", credentials: [] };
export function useCredentials(
  identity: AiIdentity | undefined,
  enabled: boolean,
  initial?: CredentialCatalogState,
  loader?: CredentialRouteData | null,
) {
  const fetcher = useFetcher<CredentialRouteData | null>();
  const [view, setView] = useState<{
    initial: typeof initial;
    loader: typeof loader;
    fetched: CredentialRouteData | null | undefined;
    observed: CredentialRouteData | null | undefined;
    version: number;
  }>({ initial, loader, fetched: undefined, observed: undefined, version: 0 });
  if (loader !== view.loader || (initial && initial !== view.initial)) {
    setView({
      initial: initial ?? view.initial,
      loader,
      fetched: undefined,
      observed: fetcher.data,
      version: view.version + 1,
    });
  } else if (fetcher.state === "idle" && fetcher.data != null && fetcher.data !== view.observed) {
    setView({ ...view, fetched: fetcher.data, observed: fetcher.data, version: view.version + 1 });
  }
  const load = fetcher.load;
  const reset = fetcher.reset;
  const signal = identity?.signal;
  const active = enabled && identity?.intent === "account";
  const refresh = useCallback(() => {
    if (active && !signal?.aborted) return load("/account/credentials");
    return Promise.resolve();
  }, [active, signal, load]);
  const onChange = useEffectEvent(() => {
    void refresh();
  });
  useEffect(() => {
    if (!active) return;
    return observeCredentialChanges(onChange);
  }, [active]);
  useEffect(() => {
    const clear = () => {
      reset();
    };
    window.addEventListener("pagehide", clear);
    signal?.addEventListener("abort", clear);
    return () => {
      window.removeEventListener("pagehide", clear);
      signal?.removeEventListener("abort", clear);
      reset();
    };
  }, [signal, reset]);
  const catalog =
    view.fetched !== undefined
      ? view.fetched?.data?.catalog
      : view.loader !== undefined
        ? view.loader?.data?.catalog
        : view.initial;
  const current = active && !signal?.aborted ? (catalog ?? empty) : empty;
  return {
    state: fetcher.state === "idle" ? current : { ...current, phase: "loading" as const },
    version: view.version,
    refresh,
  };
}
