import {
  type AiParameters,
  type AiSeat,
  gameDetailsSchema,
  gameInvocationsSchema,
  type GameSnapshot,
} from "@neurochess/contracts";
import { expect } from "vitest";

import { createLoggerOptions } from "../../src/logger.js";
import { turnCommand } from "../ai-turn-helpers.js";
import {
  ApiHarness,
  claimController,
  type TestApi,
  type TestGuest,
  WEB_ORIGIN,
} from "../helpers.js";

import { type AdapterContractFixture, PROVIDER_KEY } from "./adapter-contract.js";
import { type HttpStep, mockHttp } from "./mock-http.js";

interface ProviderApiContext {
  api: TestApi;
  guest: TestGuest;
  harness: ApiHarness;
  http: ReturnType<typeof mockHttp>;
  logs: string[];
}

export async function withProviderApi(
  fixture: AdapterContractFixture,
  steps: readonly HttpStep[],
  run: (context: ProviderApiContext) => Promise<void>,
  providerTimeouts: { turnMs?: number } = {},
): Promise<void> {
  const harness = new ApiHarness();
  const http = mockHttp(steps);
  const logs: string[] = [];
  try {
    const api = await harness.createApi({
      aiAdapters: { [fixture.provider]: fixture.createAdapter(http.transport) },
      providerTimeouts,
      logger: {
        ...createLoggerOptions("info"),
        stream: { write: (chunk: string) => logs.push(chunk) },
      },
    });
    const guest = await harness.guest(api);
    await run({ api, guest, harness, http, logs });
  } finally {
    await harness.dispose();
  }
}

export function post(api: TestApi, guest: TestGuest, url: string, payload: object) {
  return api.app.inject({
    method: "POST",
    url,
    payload,
    headers: { origin: WEB_ORIGIN, cookie: guest.cookie },
  });
}

export async function createProviderGame(
  api: TestApi,
  guest: TestGuest,
  fixture: AdapterContractFixture,
  parameters: AiParameters = {},
  modelId = fixture.modelId,
  black: Pick<AiSeat, "modelId" | "parameters"> = { modelId, parameters: {} },
) {
  const seat = { type: "ai", provider: fixture.provider, modelId, parameters };
  const response = await post(api, guest, "/games", {
    mode: "ai_vs_ai",
    seats: {
      white: seat,
      black: { ...seat, modelId: black.modelId, parameters: black.parameters },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  const snapshot = gameDetailsSchema.parse(response.json()).snapshot;
  await claimController(api, guest, snapshot);
  return snapshot;
}

export function turn(api: TestApi, guest: TestGuest, snapshot: GameSnapshot) {
  return post(api, guest, `/games/${snapshot.gameId}/ai-turn`, {
    ...turnCommand(snapshot),
    apiKey: PROVIDER_KEY,
  });
}

export async function records(api: TestApi, guest: TestGuest, gameId: string) {
  const response = await api.app.inject({
    method: "GET",
    url: `/games/${gameId}/invocations`,
    headers: { cookie: guest.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return gameInvocationsSchema.parse(response.json());
}
