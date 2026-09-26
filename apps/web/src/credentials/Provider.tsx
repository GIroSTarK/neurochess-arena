import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";

import { createCredentialApi } from "./client";
import { CredentialContext } from "./context";
import { CredentialController } from "./controller";

export function CredentialProvider({
  apiBaseUrl,
  enabled,
  lifetime,
  onUnauthorized,
  children,
}: {
  readonly apiBaseUrl: string;
  readonly enabled: boolean;
  readonly lifetime: AbortSignal;
  readonly onUnauthorized: () => void;
  readonly children: ReactNode;
}) {
  const [controller] = useState(
    () => new CredentialController(createCredentialApi(apiBaseUrl), lifetime, onUnauthorized),
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    if (enabled) void controller.refresh();
    return () => controller.cancelRead();
  }, [controller, enabled]);
  return (
    <CredentialContext value={enabled ? { controller, state } : null}>{children}</CredentialContext>
  );
}
