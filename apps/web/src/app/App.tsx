import { useSyncExternalStore } from "react";

import { SandboxScreen } from "../game/SandboxScreen";

import { DocumentMetadata } from "./DocumentMetadata";
import { readAppPage, subscribeToNavigation } from "./navigation";
import { StaticScreen } from "./StaticScreen";

export interface AppProps {
  readonly apiBaseUrl: string;
  readonly sandboxEnabled: boolean;
}

export function App({ apiBaseUrl, sandboxEnabled }: AppProps) {
  const requestedPage = useSyncExternalStore(subscribeToNavigation, readAppPage);
  const page = requestedPage === "sandbox" && !sandboxEnabled ? "not-found" : requestedPage;

  return (
    <>
      <DocumentMetadata page={page} />
      {page === "sandbox" ? (
        <SandboxScreen apiBaseUrl={apiBaseUrl} />
      ) : (
        <StaticScreen page={page} sandboxEnabled={sandboxEnabled} />
      )}
    </>
  );
}
