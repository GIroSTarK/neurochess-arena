import { DocumentMetadata } from "../shell/document-metadata";
import { RouteNotice } from "../shell/route-notice";

export function RouteErrorBoundary() {
  return (
    <>
      <DocumentMetadata page="not-found" />
      <RouteNotice kind="error" onRetry={() => window.location.reload()} />
    </>
  );
}
