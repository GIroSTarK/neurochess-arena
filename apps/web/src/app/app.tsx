import type { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";

function reportRouteError(error: unknown) {
  const code =
    error instanceof Error && error.message === "ROUTE_MODULE_UNAVAILABLE"
      ? "ROUTE_MODULE_UNAVAILABLE"
      : "ROUTE_FAILURE";
  // Router errors and their metadata may contain private inputs or URLs.
  console.error("Route error", code);
}

export function App({ router }: { readonly router: ReturnType<typeof createBrowserRouter> }) {
  return <RouterProvider router={router} onError={reportRouteError} />;
}
