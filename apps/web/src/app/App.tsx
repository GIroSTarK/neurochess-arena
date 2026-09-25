import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from "react";

import { AccountApp } from "../auth/AccountApp";
import { type AuthEntry, consumeAuthEntry } from "../auth/navigation";

import { DocumentMetadata } from "./DocumentMetadata";
import { readAppPage, subscribeToNavigation } from "./navigation";
import { SandboxLoadingScreen } from "./SandboxLoadingScreen";
import { StaticScreen } from "./StaticScreen";

declare const __ARENA_REFERENCE_ENABLED__: boolean;

// Keep the import behind Vite's literal flag so disabled builds omit the whole client.
const SandboxScreen =
  import.meta.env.SANDBOX_ENABLED === "true"
    ? lazy(() =>
        import("../game/SandboxScreen").then((module) => ({
          default: module.SandboxScreen,
        })),
      )
    : null;

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
  readonly authEntry?: AuthEntry;
}

export function App({ apiBaseUrl, sandboxEnabled, authEntry = {} }: AppProps) {
  const [callback, setCallback] = useState({ entry: authEntry, revision: 0 });
  useEffect(() => {
    const consume = () => {
      if (
        window.location.pathname.startsWith("/auth/") &&
        /^#(?:token|status|error)=/.test(window.location.hash)
      ) {
        const entry = consumeAuthEntry();
        setCallback((previous) => ({ entry, revision: previous.revision + 1 }));
      }
    };
    window.addEventListener("hashchange", consume);
    return () => window.removeEventListener("hashchange", consume);
  }, []);
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
  if (requestedPage === "sandbox" && sandboxEnabled && SandboxScreen) {
    return (
      <>
        <DocumentMetadata page="sandbox" />
        <Suspense fallback={<SandboxLoadingScreen />}>
          <SandboxScreen apiBaseUrl={apiBaseUrl} />
        </Suspense>
      </>
    );
  }
  const page =
    requestedPage === "sandbox" || requestedPage === "reference" ? "not-found" : requestedPage;

  return (
    <>
      <DocumentMetadata page={page} />
      {page !== "not-found" ? (
        <AccountApp
          page={page}
          entry={callback.entry}
          entryRevision={callback.revision}
          apiBaseUrl={apiBaseUrl}
          sandboxEnabled={sandboxEnabled && SandboxScreen !== null}
        />
      ) : (
        <StaticScreen page={page} sandboxEnabled={sandboxEnabled && SandboxScreen !== null} />
      )}
    </>
  );
}
