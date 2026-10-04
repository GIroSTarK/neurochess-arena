import { DocumentMetadata } from "./DocumentMetadata";
import { RouteNotice } from "./RouteNotice";

export function RouteErrorBoundary({ sandboxEnabled }: { readonly sandboxEnabled: boolean }) {
  return (
    <>
      <DocumentMetadata page="not-found" />
      <RouteNotice
        kind="error"
        sandboxEnabled={sandboxEnabled}
        onRetry={() => window.location.reload()}
      />
    </>
  );
}
