import { expect, vi } from "vitest";

type HttpHandler = (options: RequestInit | undefined) => Response | Promise<Response>;
export type HttpRoutes = Partial<Record<`${"GET" | "POST"} /${string}`, HttpHandler>>;

export function createHttpMock(routes: HttpRoutes = {}) {
  const handlers = new Map(Object.entries(routes));
  const unexpectedRequests: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, options) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = (
      options?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const request = `${method} ${url.pathname}${url.search}`;
    const handler = handlers.get(request);
    if (!handler) {
      unexpectedRequests.push(request);
      throw new Error("Unexpected HTTP request: " + request);
    }
    return handler(options);
  });

  return {
    fetch,
    // The client catches fetch errors, so each consumer must also verify this at teardown.
    assertNoUnexpectedRequests() {
      expect(unexpectedRequests, "Unexpected HTTP requests").toEqual([]);
    },
  };
}
