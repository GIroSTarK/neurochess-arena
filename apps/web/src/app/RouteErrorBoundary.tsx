import { DocumentMetadata } from "./DocumentMetadata";
import { RouteNotice } from "./RouteNotice";

export function RouteErrorBoundary() {
  return (
    <>
      <DocumentMetadata page="not-found" />
      <RouteNotice kind="error" onRetry={() => window.location.reload()} />
    </>
  );
}
