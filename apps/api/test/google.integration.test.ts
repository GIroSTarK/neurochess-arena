import {
  type AiParameters,
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
import { createGoogleAdapter } from "../src/providers/google.js";

import { control, turnCommand } from "./ai-turn-helpers.js";
import {
  ApiHarness,
  claimController,
  snapshot,
  type TestApi,
  type TestGuest,
  WEB_ORIGIN,
} from "./helpers.js";
import { PROVIDER_KEY } from "./providers/adapter-contract.js";
import {
  googleCatalog,
  googleFixture,
  googleModel,
  googleResponse,
} from "./providers/google-fixtures.js";
import { mockHttp } from "./providers/mock-http.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());

function post(api: TestApi, guest: TestGuest, url: string, payload: object) {
  return api.app.inject({
    method: "POST",
    url,
    payload,
    headers: { origin: WEB_ORIGIN, cookie: guest.cookie },
  });
}
async function create(
  api: TestApi,
  guest: TestGuest,
  parameters: AiParameters = {},
  modelId = googleFixture.modelId,
) {
  const seat = { type: "ai", provider: "google", modelId, parameters };
  const response = await post(api, guest, "/games", {
    mode: "ai_vs_ai",
    seats: { white: seat, black: { ...seat, parameters: {} } },
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

describe("registered Google adapter through HTTP, PostgreSQL and authoritative orchestration", () => {
  it("authorizes discovery/turns, preserves full-history context, persists sent parameters and redacts credentials", async () => {
    const logs: string[] = [];
    const http = mockHttp([
      Response.json(googleCatalog()),
      Response.json(googleCatalog()),
      Response.json({
        ...googleResponse(JSON.stringify({ move: "e2e4", commentary: PROVIDER_KEY }), {
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 140,
        }),
        responseId: PROVIDER_KEY,
      }),
      Response.json(googleCatalog()),
      Response.json(googleResponse('{"move":"g8f6","commentary":"Develops a knight."}')),
    ]);
    const api = await harness.createApi({
      aiAdapters: { google: createGoogleAdapter(http.transport) },
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
      payload: { provider: "google", apiKey: PROVIDER_KEY },
      headers: { origin: WEB_ORIGIN },
    });
    expect(denied.statusCode).toBe(401);
    expect(http.transport).not.toHaveBeenCalled();
    const discovery = await post(api, guest, "/providers/models", {
      provider: "google",
      apiKey: PROVIDER_KEY,
    });
    expect(discovery.json()).toMatchObject({ ok: true });
    expect(discovery.headers["cache-control"]).toBe("no-store");
    const initial = await create(api, guest, {
      temperature: 0.2,
      reasoningEffort: "low",
      maxOutputTokens: 256,
    });
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
    expect(gameSnapshotSchema.parse(second.json()).moves.map(({ uci }) => uci)).toEqual([
      "e2e4",
      "g8f6",
    ]);
    const whiteRequest = await googleFixture.readMove(http.requests[2]!);
    const blackRequest = await googleFixture.readMove(http.requests[4]!);
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
      expect(JSON.stringify(request.context)).not.toMatch(
        /gemini-|commentary|stockfish|evaluation/i,
      );
    }
    expect(whiteRequest.parameters).toEqual({ temperature: 0.2, maxOutputTokens: 256 });
    expect(blackRequest.parameters).toEqual({});
    const invocations = await records(api, guest, initial.gameId);
    expect(invocations.turns[0]!.attempts[0]).toMatchObject({
      outcome: "accepted",
      effectiveParameters: whiteRequest.parameters,
      commentary: null,
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 140 },
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

  it("leaves malformed/illegal output retries and the third-invalid technical loss to the shared runner", async () => {
    for (const validThird of [true, false]) {
      const http = mockHttp([
        Response.json(googleCatalog()),
        googleFixture.failure("truncated_output"),
        Response.json(googleResponse('{"move":"e2e5"}')),
        validThird
          ? Response.json(googleResponse('{"move":"e2e4"}'))
          : googleFixture.failure("refusal"),
      ]);
      const api = await harness.createApi({
        aiAdapters: { google: createGoogleAdapter(http.transport) },
      });
      const guest = await harness.guest(api);
      const initial = await create(api, guest);
      const response = await turn(api, guest, initial);
      expect(response.statusCode, response.body).toBe(200);
      const snapshot = gameSnapshotSchema.parse(response.json());
      expect(snapshot).toMatchObject(
        validThird
          ? { state: "active", result: "*" }
          : {
              state: "completed",
              result: "0-1",
              terminationReason: "model_technical_loss",
            },
      );
      expect(snapshot.moves.map(({ uci }) => uci)).toEqual(validThird ? ["e2e4"] : []);
      const log = await records(api, guest, initial.gameId);
      expect(log.turns[0]).toMatchObject({
        invalidOutputCount: validThird ? 2 : 3,
        acceptedMovePly: validThird ? 1 : null,
        attempts: [
          { outcome: "model_invalid", error: { reason: "truncated_output" } },
          { outcome: "model_invalid", error: { reason: "illegal_move" } },
          { outcome: validThird ? "accepted" : "model_invalid" },
        ],
      });
      expect(
        log.turns[0]!.attempts.every(
          ({ effectiveParameters }) => Object.keys(effectiveParameters).length === 0,
        ),
      ).toBe(true);
      expect(http.transport).toHaveBeenCalledTimes(4);
    }
  });

  it("pauses on quota failure and retains the output budget across explicit resume/retry", async () => {
    const http = mockHttp([
      Response.json(googleCatalog()),
      googleFixture.failure("malformed_output"),
      googleFixture.failure("quota"),
      Response.json(googleCatalog()),
      Response.json(googleResponse('{"move":"e2e4"}')),
    ]);
    const logs: string[] = [];
    const api = await harness.createApi({
      aiAdapters: { google: createGoogleAdapter(http.transport) },
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
    expect(http.transport).toHaveBeenCalledTimes(3);
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

  it("rejects settings invalidated by fresh discovery before inference or invocation insertion", async () => {
    const http = mockHttp([
      Response.json({ ...googleCatalog(), models: [{ ...googleModel(), outputTokenLimit: 100 }] }),
    ]);
    const api = await harness.createApi({
      aiAdapters: { google: createGoogleAdapter(http.transport) },
    });
    const guest = await harness.guest(api);
    const initial = await create(api, guest, { maxOutputTokens: 256 });
    const response = await turn(api, guest, initial);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "AI_PARAMETERS_INVALID" });
    expect((await records(api, guest, initial.gameId)).turns[0]!.attempts).toEqual([]);
    expect((await snapshot(api, guest, initial.gameId)).state).toBe("paused");
    expect(http.transport).toHaveBeenCalledTimes(1);
  });

  it("persists no speculative parameters for unknown capabilities", async () => {
    const http = mockHttp([
      Response.json(googleCatalog(["future-text-model"])),
      Response.json(googleResponse('{"move":"e2e4"}')),
    ]);
    const api = await harness.createApi({
      aiAdapters: { google: createGoogleAdapter(http.transport) },
    });
    const guest = await harness.guest(api);
    const initial = await create(
      api,
      guest,
      { maxOutputTokens: 9999, reasoningEffort: "max" },
      "future-text-model",
    );
    expect((await turn(api, guest, initial)).statusCode).toBe(200);
    const sent = (await googleFixture.readMove(http.requests[1]!)).parameters;
    expect(sent).toEqual({});
    expect(
      (await records(api, guest, initial.gameId)).turns[0]!.attempts[0]!.effectiveParameters,
    ).toEqual(sent);
  });

  it("propagates the operational deadline and records a provider pause", async () => {
    let signal: AbortSignal | undefined;
    const http = mockHttp([
      Response.json(googleCatalog()),
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          signal = request.signal;
          signal.addEventListener("abort", () => reject(new Error(PROVIDER_KEY)), { once: true });
        }),
    ]);
    const api = await harness.createApi({
      aiAdapters: { google: createGoogleAdapter(http.transport) },
      providerTimeouts: { turnMs: 150 },
    });
    const guest = await harness.guest(api);
    const initial = await create(api, guest);
    const response = await turn(api, guest, initial);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ state: "paused", moves: [] });
    expect(signal?.aborted).toBe(true);
    expect((await records(api, guest, initial.gameId)).turns[0]).toMatchObject({
      invalidOutputCount: 0,
      attempts: [{ error: { code: "provider_timeout" } }],
    });
  });

  it("pauses models that disappear or no longer advertise generateContent without inference", async () => {
    for (const catalog of [
      googleCatalog([]),
      { models: [{ ...googleModel(), supportedGenerationMethods: ["embedContent"] }] },
    ]) {
      const http = mockHttp([Response.json(catalog)]);
      const api = await harness.createApi({
        aiAdapters: { google: createGoogleAdapter(http.transport) },
      });
      const guest = await harness.guest(api);
      const initial = await create(api, guest);
      const response = await turn(api, guest, initial);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ state: "paused", moves: [], result: "*" });
      expect((await records(api, guest, initial.gameId)).turns[0]).toMatchObject({
        invalidOutputCount: 0,
        attempts: [
          {
            outcome: "provider_error",
            error: { code: "provider_unavailable", reason: "unsupported_model" },
            usage: null,
            effectiveParameters: {},
          },
        ],
      });
      expect(http.transport).toHaveBeenCalledTimes(1);
    }
  });

  it("discards a Google response arriving after Stop", async () => {
    const entered = Promise.withResolvers<void>();
    const result = Promise.withResolvers<Response>();
    const http = mockHttp([
      Response.json(googleCatalog()),
      () => {
        entered.resolve();
        return result.promise;
      },
    ]);
    const api = await harness.createApi({
      aiAdapters: { google: createGoogleAdapter(http.transport) },
    });
    const guest = await harness.guest(api);
    const initial = await create(api, guest);
    const pending = turn(api, guest, initial);
    await entered.promise;
    expect(
      (await post(api, guest, `/games/${initial.gameId}/lifecycle`, control(initial, "abort")))
        .statusCode,
    ).toBe(200);
    result.resolve(Response.json(googleResponse('{"move":"e2e4"}')));
    expect((await pending).statusCode).toBe(409);
    expect(await snapshot(api, guest, initial.gameId)).toMatchObject({
      state: "aborted",
      moves: [],
    });
    expect((await records(api, guest, initial.gameId)).turns[0]!.attempts[0]).toMatchObject({
      outcome: "discarded",
    });
  });
});
