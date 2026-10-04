import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";

import type { AiIdentity } from "../api/ai-client";
import { createCredentialApi } from "../api/credential-client";

import { CredentialCatalog, type CredentialCatalogState } from "./catalog";

export function useCredentials(
  apiBaseUrl: string,
  identity?: AiIdentity,
  enabled = true,
  initial?: CredentialCatalogState,
) {
  const [catalog] = useState(
    () =>
      new CredentialCatalog(
        identity?.intent === "account" ? createCredentialApi(apiBaseUrl, identity) : null,
      ),
  );
  const state = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot);
  const entry = useEffectEvent(() => initial);
  useEffect(() => (enabled ? catalog.connect(entry()) : undefined), [catalog, enabled]);
  return { catalog, state };
}
