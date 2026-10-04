import type { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";

export function App({ router }: { readonly router: ReturnType<typeof createBrowserRouter> }) {
  return <RouterProvider router={router} onError={() => undefined} />;
}
