import { describe, expect, it, vi } from "vitest";

import { createSandboxApi } from "../api/client";

import { GAME_ID, jsonResponse, OTHER_GAME_ID } from "./fixtures";
import { createHttpMock } from "./http";

const API_ORIGIN = "http://localhost:3001";

describe("strict HTTP mock", () => {
  it.each([
    { name: "string URL", input: API_ORIGIN + "/ready", options: undefined },
    { name: "URL object", input: new URL("/ready", API_ORIGIN), options: undefined },
    { name: "Request object", input: new Request(API_ORIGIN + "/ready"), options: undefined },
    {
      name: "Request with method override",
      input: new Request(API_ORIGIN + "/ready", { method: "POST" }),
      options: { method: "get" },
    },
  ])("matches the effective method for $name", async ({ input, options }) => {
    const http = createHttpMock({ "GET /ready": () => jsonResponse({ status: "ready" }) });
    const response = await http.fetch(input, options);
    expect(await response.json()).toEqual({ status: "ready" });
    http.assertNoUnexpectedRequests();
  });

  it("uses a Request's method when init does not override it", async () => {
    const http = createHttpMock({ "POST /guest-session": () => jsonResponse({ status: "ready" }) });
    const response = await http.fetch(
      new Request(API_ORIGIN + "/guest-session", { method: "POST" }),
    );
    expect(response.status).toBe(200);
    http.assertNoUnexpectedRequests();
  });

  it.each([
    ["GET", "/wrong-unregistered-route"],
    ["GET", "/sandbox/games"],
    ["DELETE", `/games/${GAME_ID}/moves`],
    ["GET", `/games/${GAME_ID}/moves`],
    ["POST", `/wrong-prefix/${GAME_ID}/moves`],
    ["GET", `/games/${OTHER_GAME_ID}`],
    ["GET", `/games/${OTHER_GAME_ID}/replay`],
    ["GET", "/ready?unexpected=true"],
  ])("rejects and records %s %s without calling a handler", async (method, path) => {
    const handler = vi.fn(() => jsonResponse({ status: "ready" }));
    const http = createHttpMock({
      "GET /ready": handler,
      "POST /sandbox/games": handler,
      [`GET /games/${GAME_ID}`]: handler,
      [`POST /games/${GAME_ID}/moves`]: handler,
      [`GET /games/${GAME_ID}/replay`]: handler,
    });

    await expect(http.fetch(new URL(path, API_ORIGIN), { method })).rejects.toThrow(
      `Unexpected HTTP request: ${method} ${path}`,
    );
    expect(handler).not.toHaveBeenCalled();
    expect(() => http.assertNoUnexpectedRequests()).toThrow("Unexpected HTTP requests");
  });

  it("fails verification even when the client normalizes an unexpected request", async () => {
    const http = createHttpMock();
    const api = createSandboxApi(API_ORIGIN, { fetch: http.fetch });

    await expect(api.create(new AbortController().signal)).rejects.toMatchObject({
      kind: "network",
    });
    expect(() => http.assertNoUnexpectedRequests()).toThrow("POST /sandbox/games");
  });
});
