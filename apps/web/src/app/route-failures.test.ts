import { waitFor } from "@testing-library/react";
import { createMemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";

import { createAppRouter } from "./router";

vi.mock("../game/SandboxRouteLayout", () => {
  throw new Error("private-import-error-canary");
});

it("reduces module exceptions to a bounded route error before router caching", async () => {
  const router = createAppRouter(
    { apiBaseUrl: "http://localhost:3001", sandboxEnabled: true },
    (routes) => createMemoryRouter(routes, { initialEntries: ["/sandbox"] }),
  );
  try {
    await waitFor(() => expect(router.state.initialized).toBe(true));
    const error = Object.values(router.state.errors ?? {})[0] as Error;
    expect(error.message).toBe("ROUTE_MODULE_UNAVAILABLE");
    expect(error.cause).toBeUndefined();
  } finally {
    router.dispose();
  }
});
