import { lazy, Suspense, useState, useSyncExternalStore } from "react";

import { AccountApplication } from "../auth/AccountApplication";
import { type AuthEntry, consumeAuthEntry } from "../auth/navigation";

import { DocumentMetadata } from "./DocumentMetadata";
import { accountPage, appPage, authForm, readPathname, subscribeToNavigation } from "./navigation";
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

export function App({ apiBaseUrl, sandboxEnabled, authEntry }: AppProps) {
  const pathname = useSyncExternalStore(subscribeToNavigation, readPathname);
  const requestedPage = appPage(pathname);
  const [entry] = useState(() => authEntry ?? consumeAuthEntry());
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
    requestedPage === "arena" || requestedPage === "account" || requestedPage === "history"
      ? requestedPage
      : "not-found";

  return (
    <>
      <DocumentMetadata page={page} />
      {page !== "not-found" ? (
        <AccountApplication
          apiBaseUrl={apiBaseUrl}
          sandboxEnabled={sandboxEnabled && SandboxScreen !== null}
          page={accountPage(pathname)}
          form={authForm(pathname)}
          entry={entry}
        />
      ) : (
        <StaticScreen page={page} sandboxEnabled={sandboxEnabled && SandboxScreen !== null} />
      )}
    </>
  );
}
