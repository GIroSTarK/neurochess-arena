import {
  type ModelDescriptor,
  type ProviderErrorKind,
  type ProviderId,
  sessionCredentialSchema,
} from "@neurochess/contracts";
import { useEffect, useRef, useState } from "react";

import type { AiSetupApi } from "../api/ai";

import { emptySeat, seatConfiguration } from "./configuration";

type Discovery =
  | { status: "idle" | "loading" }
  | { status: "error"; kind: ProviderErrorKind | "service" }
  | { status: "ready"; models: ModelDescriptor[]; expiresAt: number; catalogId: string };

export function useAiSeat(api: AiSetupApi) {
  const [draft, setDraft] = useState(emptySeat);
  const [invalidNumbers, setInvalidNumbers] = useState<ReadonlySet<string>>(() => new Set());
  // Credentials are deliberately outside the serializable configuration and catalog.
  const [key, setKey] = useState("");
  const [discovery, setDiscovery] = useState<Discovery>({ status: "idle" });
  const pending = useRef<AbortController | null>(null);
  const previousCatalog = useRef<string | undefined>(undefined);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    const clear = () => {
      pending.current?.abort();
      pending.current = null;
      previousCatalog.current = undefined;
      setKey("");
      setDiscovery({ status: "idle" });
    };
    window.addEventListener("pagehide", clear);
    return () => window.removeEventListener("pagehide", clear);
  }, []);
  useEffect(() => {
    if (discovery.status !== "ready") return;
    const timer = setTimeout(
      () => {
        setInvalidNumbers(new Set());
        setDiscovery({ status: "idle" });
      },
      Math.max(0, discovery.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [discovery]);

  function invalidate() {
    pending.current?.abort();
    pending.current = null;
    resetNumericValidity();
    setDiscovery({ status: "idle" });
  }
  function resetNumericValidity() {
    // Native bad-input text is absent from input.value and is lost when controls are recreated.
    setInvalidNumbers(new Set());
  }
  function resetDiscovery() {
    invalidate();
    previousCatalog.current = undefined;
  }
  function changeProvider(provider: ProviderId | "") {
    resetDiscovery();
    setKey("");
    setDraft(emptySeat(provider));
  }
  function changeKey(value: string) {
    invalidate();
    setKey(value);
  }
  function changeModel(modelId: string) {
    resetNumericValidity();
    setDraft((previous) => ({ ...emptySeat(previous.provider), modelId }));
  }
  function changeParameter(
    name: "temperature" | "reasoningEffort" | "maxOutputTokens",
    value: string,
    badInput = false,
  ) {
    setInvalidNumbers((previous) => {
      const next = new Set(previous);
      if (badInput) next.add(name);
      else next.delete(name);
      return next;
    });
    setDraft((previous) => ({ ...previous, [name]: value }));
  }
  function ensureFresh() {
    if (discovery.status !== "ready" || discovery.expiresAt <= Date.now()) {
      invalidate();
      return false;
    }
    return true;
  }
  async function discover() {
    const credential = sessionCredentialSchema.safeParse({ provider: draft.provider, apiKey: key });
    if (!credential.success || pending.current) return;
    const abort = new AbortController();
    const catalogId = previousCatalog.current;
    previousCatalog.current = undefined;
    pending.current = abort;
    resetNumericValidity();
    setDiscovery({ status: "loading" });
    try {
      const result = await api.discover(credential.data, abort.signal, catalogId);
      if (abort.signal.aborted) return;
      if (result.ok) {
        previousCatalog.current = result.catalogId;
        setDiscovery({
          status: "ready",
          models: result.value,
          expiresAt: Date.now() + 5 * 60_000,
          catalogId: result.catalogId,
        });
        setDraft((previous) =>
          result.value.some((model) => model.id === previous.modelId)
            ? previous
            : emptySeat(previous.provider),
        );
      } else {
        setDiscovery({ status: "error", kind: result.error.kind });
      }
    } catch {
      if (!abort.signal.aborted) setDiscovery({ status: "error", kind: "service" });
    } finally {
      credential.data.apiKey = "";
      if (pending.current === abort) pending.current = null;
    }
  }
  const model =
    discovery.status === "ready"
      ? discovery.models.find((candidate) => candidate.id === draft.modelId)
      : undefined;
  const credentialReady = sessionCredentialSchema.safeParse({
    provider: draft.provider,
    apiKey: key,
  }).success;
  const configuration = invalidNumbers.size ? null : seatConfiguration(draft, model);
  const ready = credentialReady && configuration !== null && discovery.status === "ready";
  const selection =
    configuration && discovery.status === "ready"
      ? { ...configuration, catalogId: discovery.catalogId }
      : null;
  return {
    draft,
    key,
    discovery,
    model,
    credentialReady,
    configuration,
    selection,
    ready,
    invalidNumbers,
    resetNumericValidity,
    resetDiscovery,
    ensureFresh,
    changeProvider,
    changeKey,
    changeModel,
    changeParameter,
    discover,
  };
}

export type AiSeatState = ReturnType<typeof useAiSeat>;
