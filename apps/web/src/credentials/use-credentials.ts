import { useEffect, useState, useSyncExternalStore } from "react";

import type { AiIdentity } from "../api/ai-client";
import { createCredentialApi } from "../api/credential-client";

import { CredentialCatalog } from "./catalog";

export function useCredentials(apiBaseUrl: string, identity?: AiIdentity, enabled = true) {
  const [catalog] = useState(
    () =>
      new CredentialCatalog(
        identity?.intent === "account" ? createCredentialApi(apiBaseUrl, identity) : null,
      ),
  );
  const state = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot);
  useEffect(() => (enabled ? catalog.connect() : undefined), [catalog, enabled]);
  return { catalog, state };
}
