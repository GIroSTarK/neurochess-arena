import { vi } from "vitest";

export type HttpStep = Response | Error | ((request: Request) => Response | Promise<Response>);

export function mockHttp(steps: readonly HttpStep[]) {
  const requests: Request[] = [];
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    const request = new Request(url, init);
    requests.push(request);
    const step = steps[requests.length - 1];
    if (step === undefined) throw new Error("Mock HTTP transport exhausted");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(request) : step;
  });
  return { transport, requests };
}
