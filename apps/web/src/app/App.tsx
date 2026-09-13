import { lazy, Suspense, useSyncExternalStore } from "react";

import { SandboxScreen } from "../game/SandboxScreen";

import { DocumentMetadata } from "./DocumentMetadata";
import { readAppPage, subscribeToNavigation } from "./navigation";
import { StaticScreen } from "./StaticScreen";

declare const __ARENA_REFERENCE_ENABLED__: boolean;

const ArenaReferenceScreen =
  import.meta.env.DEV && __ARENA_REFERENCE_ENABLED__
    ? lazy(() =>
        import("../reference/ArenaReferenceScreen").then((module) => ({
          default: module.ArenaReferenceScreen,
        })),
      )
    : null;

export interface AppProps {
  readonly apiBaseUrl: string;
  readonly sandboxEnabled: boolean;
}

export function App({ apiBaseUrl, sandboxEnabled }: AppProps) {
  const requestedPage = useSyncExternalStore(subscribeToNavigation, readAppPage);
  if (
    import.meta.env.DEV &&
    requestedPage === "reference" &&
    sandboxEnabled &&
    ArenaReferenceScreen
  ) {
    return (
      <>
        <DocumentMetadata page="reference" />
        <Suspense fallback={null}>
          <ArenaReferenceScreen />
        </Suspense>
      </>
    );
  }
  const page =
    requestedPage === "reference" || (requestedPage === "sandbox" && !sandboxEnabled)
      ? "not-found"
      : requestedPage;

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
