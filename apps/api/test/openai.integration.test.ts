import {
  gameDetailsSchema,
  gameInvocationsSchema,
  type GameSnapshot,
  gameSnapshotSchema,
} from "@neurochess/contracts";
import {
  aiTurnReservations,
  aiTurns,
  gameCommands,
  gameParticipants,
  games,
  modelInvocations,
  moves,
} from "@neurochess/database";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createLoggerOptions } from "../src/logger.js";
import { AI_MOVE_INSTRUCTIONS } from "../src/providers/adapter.js";
import { createOpenAiAdapter } from "../src/providers/openai.js";

import { control, turnCommand } from "./ai-turn-helpers.js";
import {
  ApiHarness,
  claimController,
  type TestApi,
  type TestGuest,
  WEB_ORIGIN,
} from "./helpers.js";
import { PROVIDER_KEY } from "./providers/adapter-contract.js";
import { mockHttp } from "./providers/mock-http.js";
import { openAiCatalog, openAiFixture, openAiResponse } from "./providers/openai-fixtures.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());
const seat = {
  type: "ai",
  provider: "openai",
  modelId: "gpt-4.1",
  parameters: { temperature: 0.2, reasoningEffort: "high", maxOutputTokens: 128 },
} as const;

function post(api: TestApi, guest: TestGuest, url: string, payload: object) {
  return api.app.inject({
    method: "POST",
    url,
    payload,
    headers: { origin: WEB_ORIGIN, cookie: guest.cookie },
  });
}
async function create(api: TestApi, guest: TestGuest) {
  const response = await post(api, guest, "/games", {
    mode: "ai_vs_ai",
    seats: {
      white: seat,
      black: {
        ...seat,
        modelId: "gpt-6-astra",
        parameters: { temperature: 1, reasoningEffort: "low", maxOutputTokens: 256 },
      },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  const snapshot = gameDetailsSchema.parse(response.json()).snapshot;
  await claimController(api, guest, snapshot);
  return snapshot;
}
function turn(api: TestApi, guest: TestGuest, snapshot: GameSnapshot) {
  return post(api, guest, `/games/${snapshot.gameId}/ai-turn`, {
    ...turnCommand(snapshot),
    apiKey: PROVIDER_KEY,
  });
}
async function records(api: TestApi, guest: TestGuest, gameId: string) {
  const response = await api.app.inject({
    method: "GET",
    url: `/games/${gameId}/invocations`,
    headers: { cookie: guest.cookie },
  });
  expect(response.statusCode).toBe(200);
  return gameInvocationsSchema.parse(response.json());
}

describe("registered OpenAI adapter through HTTP, PostgreSQL and authoritative orchestration", () => {
  it("authorizes discovery/turns, preserves fair full-history context, persists effective parameters and redacts credentials", async () => {
    const logs: string[] = [];
    const http = mockHttp([
      Response.json(openAiCatalog()),
      Response.json(openAiCatalog()),
      Response.json({
        ...openAiResponse(JSON.stringify({ move: "e2e4", commentary: `echo ${PROVIDER_KEY}` }), {
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 110,
        }),
        id: PROVIDER_KEY,
      }),
      Response.json(openAiCatalog()),
      Response.json(openAiResponse('{"move":"g8f6","commentary":"Develops a knight."}')),
    ]);
    const api = await harness.createApi({
      aiAdapters: { openai: createOpenAiAdapter(http.transport) },
      logger: {
        ...createLoggerOptions("info"),
        stream: { write: (chunk: string) => logs.push(chunk) },
      },
    });
    const guest = await harness.guest(api);
    const stranger = await harness.guest(api);
    const denied = await api.app.inject({
      method: "POST",
      url: "/providers/models",
      payload: { provider: "openai", apiKey: PROVIDER_KEY },
      headers: { origin: WEB_ORIGIN },
    });
    expect(denied.statusCode).toBe(401);
    expect(http.transport).not.toHaveBeenCalled();
    const discovery = await post(api, guest, "/providers/models", {
      provider: "openai",
      apiKey: PROVIDER_KEY,
    });
    expect(discovery.json()).toMatchObject({ ok: true });
    expect(discovery.headers["cache-control"]).toBe("no-store");
    const initial = await create(api, guest);
    expect((await turn(api, stranger, initial)).statusCode).toBe(404);
    expect(http.transport).toHaveBeenCalledTimes(1);
    const command = { ...turnCommand(initial), apiKey: PROVIDER_KEY };
    const first = await post(api, guest, `/games/${initial.gameId}/ai-turn`, command);
    expect(first.statusCode, first.body).toBe(200);
    const afterWhite = gameSnapshotSchema.parse(first.json());
    expect(afterWhite.moves.map(({ uci }) => uci)).toEqual(["e2e4"]);
    expect((await post(api, guest, `/games/${initial.gameId}/ai-turn`, command)).statusCode).toBe(
      409,
    );
    expect(http.transport).toHaveBeenCalledTimes(3);
    const second = await turn(api, guest, afterWhite);
    expect(second.statusCode, second.body).toBe(200);
    const afterBlack = gameSnapshotSchema.parse(second.json());
    expect(afterBlack.moves.map(({ uci }) => uci)).toEqual(["e2e4", "g8f6"]);
    const whiteRequest = await openAiFixture.readMove(http.requests[2]!);
    const blackRequest = await openAiFixture.readMove(http.requests[4]!);
    for (const [request, snapshot] of [
      [whiteRequest, initial],
      [blackRequest, afterWhite],
    ] as const) {
      expect(request.instructions).toBe(AI_MOVE_INSTRUCTIONS);
      expect(request.context).toEqual({
        fen: snapshot.fen,
        pgn: snapshot.pgn,
        color: snapshot.turn,
        turn: snapshot.turn,
        legalMoves: snapshot.legalMoves,
      });
      expect(JSON.stringify(request.context)).not.toMatch(/gpt-|commentary|stockfish|evaluation/i);
    }
    expect(whiteRequest.parameters).toEqual({ temperature: 0.2, maxOutputTokens: 128 });
    expect(blackRequest.parameters).toEqual({ reasoningEffort: "low", maxOutputTokens: 256 });
    const invocations = await records(api, guest, initial.gameId);
    expect(invocations.turns[0]!.attempts[0]).toMatchObject({
      outcome: "accepted",
      effectiveParameters: whiteRequest.parameters,
      commentary: null,
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    });
    expect(invocations.turns[1]!.attempts[0]).toMatchObject({
      outcome: "accepted",
      effectiveParameters: blackRequest.parameters,
      commentary: "Develops a knight.",
      usage: null,
    });
    const stored = await Promise.all([
      api.database.db.select().from(games).where(eq(games.id, initial.gameId)),
      api.database.db
        .select()
        .from(gameParticipants)
        .where(eq(gameParticipants.gameId, initial.gameId)),
      api.database.db.select().from(moves).where(eq(moves.gameId, initial.gameId)),
      api.database.db.select().from(gameCommands).where(eq(gameCommands.gameId, initial.gameId)),
      api.database.db.select().from(aiTurns).where(eq(aiTurns.gameId, initial.gameId)),
      api.database.db
        .select()
        .from(aiTurnReservations)
        .where(eq(aiTurnReservations.gameId, initial.gameId)),
      api.database.db
        .select()
        .from(modelInvocations)
        .innerJoin(aiTurns, eq(modelInvocations.turnId, aiTurns.id))
        .where(eq(aiTurns.gameId, initial.gameId)),
    ]);
    expect(
      JSON.stringify({
        stored,
        invocations,
        logs,
        responses: [discovery.body, denied.body, first.body, second.body],
        urls: http.requests.map(({ url }) => url),
      }),
    ).not.toContain(PROVIDER_KEY);
  });

  it("lets the shared runner retry malformed and illegal outputs, accepting only the final legal move", async () => {
    const http = mockHttp([
      Response.json(openAiCatalog()),
      openAiFixture.failure("malformed_output"),
      Response.json(openAiResponse('{"move":"e2e5"}')),
      Response.json(openAiResponse('{"move":"e2e4"}')),
    ]);
    const api = await harness.createApi({
      aiAdapters: { openai: createOpenAiAdapter(http.transport) },
    });
    const guest = await harness.guest(api);
    const initial = await create(api, guest);
    const response = await turn(api, guest, initial);
    expect(response.statusCode, response.body).toBe(200);
    expect(gameSnapshotSchema.parse(response.json()).moves.map(({ uci }) => uci)).toEqual(["e2e4"]);
    const log = await records(api, guest, initial.gameId);
    expect(log.turns[0]).toMatchObject({
      invalidOutputCount: 2,
      acceptedMovePly: 1,
      attempts: [
        { outcome: "model_invalid", error: { reason: "malformed_output" } },
        { outcome: "model_invalid", error: { reason: "illegal_move" } },
        { outcome: "accepted", error: null },
      ],
    });
    expect(http.transport).toHaveBeenCalledTimes(4);
  });

  it("commits a technical loss after three invalid Responses outputs without extra transport retries", async () => {
    const http = mockHttp([
      Response.json(openAiCatalog()),
      openAiFixture.failure("refusal"),
      openAiFixture.failure("truncated_output"),
      openAiFixture.failure("malformed_output"),
    ]);
    const api = await harness.createApi({
      aiAdapters: { openai: createOpenAiAdapter(http.transport) },
    });
    const guest = await harness.guest(api);
    const initial = await create(api, guest);
    const response = await turn(api, guest, initial);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      state: "completed",
      result: "0-1",
      terminationReason: "model_technical_loss",
      moves: [],
    });
    expect((await records(api, guest, initial.gameId)).turns[0]).toMatchObject({
      invalidOutputCount: 3,
    });
    expect(http.transport).toHaveBeenCalledTimes(4);
  });

  it("pauses for quota failure, then retains the invalid-output budget across explicit resume/retry", async () => {
    const logs: string[] = [];
    const http = mockHttp([
      Response.json(openAiCatalog()),
      openAiFixture.failure("malformed_output"),
      openAiFixture.failure("quota"),
      Response.json(openAiCatalog()),
      Response.json(openAiResponse('{"move":"e2e4"}')),
    ]);
    const api = await harness.createApi({
      aiAdapters: { openai: createOpenAiAdapter(http.transport) },
      logger: {
        ...createLoggerOptions("info"),
        stream: { write: (chunk: string) => logs.push(chunk) },
      },
    });
    const guest = await harness.guest(api);
    const initial = await create(api, guest);
    const response = await turn(api, guest, initial);
    const paused = gameSnapshotSchema.parse(response.json());
    expect(paused).toMatchObject({ state: "paused", result: "*", moves: [] });
    expect((await records(api, guest, initial.gameId)).turns[0]).toMatchObject({
      invalidOutputCount: 1,
      attempts: [
        { outcome: "model_invalid" },
        { outcome: "provider_error", error: { code: "provider_quota" } },
      ],
    });
    const resumed = gameSnapshotSchema.parse(
      (
        await post(api, guest, `/games/${initial.gameId}/lifecycle`, control(paused, "resume"))
      ).json(),
    );
    expect((await turn(api, guest, resumed)).statusCode).toBe(200);
    const log = await records(api, guest, initial.gameId);
    expect(log.turns[0]).toMatchObject({ invalidOutputCount: 1, acceptedMovePly: 1 });
    expect(log.turns[0]!.attempts).toHaveLength(3);
    expect(JSON.stringify({ log, logs, response: response.body })).not.toContain(PROVIDER_KEY);
    expect(http.transport).toHaveBeenCalledTimes(5);
  });

  it("propagates the turn deadline into fetch and records a provider pause", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const http = mockHttp([
      Response.json(openAiCatalog()),
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          upstreamSignal = request.signal;
          request.signal.addEventListener("abort", () => reject(new Error(PROVIDER_KEY)), {
            once: true,
          });
        }),
    ]);
    const api = await harness.createApi({
      aiAdapters: { openai: createOpenAiAdapter(http.transport) },
      providerTimeouts: { turnMs: 150 },
    });
    const guest = await harness.guest(api);
    const initial = await create(api, guest);
    const response = await turn(api, guest, initial);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ state: "paused", moves: [] });
    expect(upstreamSignal?.aborted).toBe(true);
    expect((await records(api, guest, initial.gameId)).turns[0]).toMatchObject({
      invalidOutputCount: 0,
      attempts: [{ error: { code: "provider_timeout" } }],
    });
    expect(http.transport).toHaveBeenCalledTimes(2);
  });

  it("cannot commit a delayed OpenAI result after Stop", async () => {
    const entered = Promise.withResolvers<void>();
    const result = Promise.withResolvers<Response>();
    const http = mockHttp([
      Response.json(openAiCatalog()),
      () => {
        entered.resolve();
        return result.promise;
      },
    ]);
    const api = await harness.createApi({
      aiAdapters: { openai: createOpenAiAdapter(http.transport) },
    });
    const guest = await harness.guest(api);
    const initial = await create(api, guest);
    const pending = turn(api, guest, initial);
    await entered.promise;
    const stopped = await post(
      api,
      guest,
      `/games/${initial.gameId}/lifecycle`,
      control(initial, "abort"),
    );
    expect(stopped.statusCode).toBe(200);
    result.resolve(Response.json(openAiResponse('{"move":"e2e4"}')));
    expect((await pending).statusCode).toBe(409);
    const snapshot = await api.app.inject({
      method: "GET",
      url: `/games/${initial.gameId}`,
      headers: { cookie: guest.cookie },
    });
    expect(snapshot.json()).toMatchObject({ state: "aborted", moves: [] });
    expect((await records(api, guest, initial.gameId)).turns[0]!.attempts[0]).toMatchObject({
      outcome: "discarded",
    });
  });
});
