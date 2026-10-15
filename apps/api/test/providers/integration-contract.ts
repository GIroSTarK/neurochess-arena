import {
  type AiParameters,
  type AiSeat,
  gameSnapshotSchema,
  type ProviderFailure,
  type TokenUsage,
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
import { describe, expect, it, vi } from "vitest";

import { AI_MOVE_INSTRUCTIONS } from "../../src/providers/adapter.js";
import { control, turnCommand } from "../ai-turn-helpers.js";
import { snapshot, WEB_ORIGIN } from "../helpers.js";

import { type AdapterContractFixture, PROVIDER_KEY } from "./adapter-contract.js";
import { createProviderGame, post, records, turn, withProviderApi } from "./integration-helpers.js";
import type { HttpStep } from "./mock-http.js";

interface IntegrationFixture {
  wire: AdapterContractFixture;
  catalog: () => Response;
  selectedParameters: AiParameters;
  effectiveParameters: AiParameters;
  black: Pick<AiSeat, "modelId" | "parameters"> & { effectiveParameters: AiParameters };
  defaultParameters: AiParameters;
  defaultEffectiveParameters: AiParameters;
  credentialEcho: () => Response;
  reportedUsage: TokenUsage;
  firstInvalid: "malformed_output" | "truncated_output";
  technicalLoss: {
    responses: () => HttpStep[];
    reasons: readonly NonNullable<Extract<ProviderFailure, { code: "model_invalid" }>["reason"]>[];
  };
  quota: () => HttpStep;
}

export function runProviderIntegrationContract(fixture: IntegrationFixture) {
  const { wire, catalog } = fixture;
  describe(`${wire.provider} adapter → Fastify → PostgreSQL contract`, () => {
    it("authorizes discovery/turns, preserves full-history context, persists effective parameters and redacts credentials", async () => {
      await withProviderApi(
        wire,
        [
          catalog(),
          catalog(),
          fixture.credentialEcho(),
          catalog(),
          wire.completion('{"move":"g8f6","commentary":"Develops a knight."}'),
        ],
        async ({ api, guest, harness, http, logs }) => {
          const stranger = await harness.guest(api);
          const denied = await api.app.inject({
            method: "POST",
            url: "/providers/models",
            payload: { provider: wire.provider, apiKey: PROVIDER_KEY },
            headers: { origin: WEB_ORIGIN },
          });
          expect(denied.statusCode).toBe(401);
          expect(http.transport).not.toHaveBeenCalled();
          const discovery = await post(api, guest, "/providers/models", {
            provider: wire.provider,
            apiKey: PROVIDER_KEY,
          });
          expect(discovery.statusCode).toBe(200);
          expect(discovery.json()).toMatchObject({ ok: true });
          expect(discovery.headers["cache-control"]).toBe("no-store");
          const initial = await createProviderGame(
            api,
            guest,
            wire,
            fixture.selectedParameters,
            wire.modelId,
            fixture.black,
          );
          const deniedTurn = await turn(api, stranger, initial);
          expect(deniedTurn.statusCode).toBe(404);
          expect(http.transport).toHaveBeenCalledTimes(1);
          const command = { ...turnCommand(initial), apiKey: PROVIDER_KEY };
          const first = await post(api, guest, `/games/${initial.gameId}/ai-turn`, command);
          expect(first.statusCode, first.body).toBe(200);
          const afterWhite = gameSnapshotSchema.parse(first.json());
          expect(afterWhite.moves.map(({ uci }) => uci)).toEqual(["e2e4"]);
          const duplicate = await post(api, guest, `/games/${initial.gameId}/ai-turn`, command);
          expect(duplicate.statusCode).toBe(409);
          expect(http.transport).toHaveBeenCalledTimes(3);
          const second = await turn(api, guest, afterWhite);
          expect(second.statusCode, second.body).toBe(200);
          const afterBlack = gameSnapshotSchema.parse(second.json());
          expect(afterBlack.moves.map(({ uci }) => uci)).toEqual(["e2e4", "g8f6"]);
          expect(await snapshot(api, guest, initial.gameId)).toEqual(afterBlack);
          const whiteRequest = await wire.readMove(http.requests[2]!);
          const blackRequest = await wire.readMove(http.requests[4]!);
          for (const [request, position] of [
            [whiteRequest, initial],
            [blackRequest, afterWhite],
          ] as const) {
            expect(request.instructions).toBe(AI_MOVE_INSTRUCTIONS);
            expect(request.context).toEqual({
              fen: position.fen,
              pgn: position.pgn,
              color: position.turn,
              turn: position.turn,
              legalMoves: position.legalMoves,
            });
            expect(JSON.stringify(request.context)).not.toMatch(
              /gpt-|claude-|gemini-|commentary|stockfish|evaluation/i,
            );
          }
          expect(whiteRequest.modelId).toBe(wire.modelId);
          expect(blackRequest.modelId).toBe(fixture.black.modelId);
          expect(whiteRequest.parameters).toEqual(fixture.effectiveParameters);
          expect(blackRequest.parameters).toEqual(fixture.black.effectiveParameters);
          const invocations = await records(api, guest, initial.gameId);
          expect(invocations.turns).toHaveLength(2);
          expect(invocations.turns[0]!.attempts).toMatchObject([
            {
              outcome: "accepted",
              effectiveParameters: whiteRequest.parameters,
              commentary: null,
              usage: fixture.reportedUsage,
            },
          ]);
          expect(invocations.turns[1]!.attempts).toMatchObject([
            {
              outcome: "accepted",
              effectiveParameters: blackRequest.parameters,
              commentary: "Develops a knight.",
              usage: null,
            },
          ]);
          const stored = await Promise.all([
            api.database.db.select().from(games).where(eq(games.id, initial.gameId)),
            api.database.db
              .select()
              .from(gameParticipants)
              .where(eq(gameParticipants.gameId, initial.gameId)),
            api.database.db.select().from(moves).where(eq(moves.gameId, initial.gameId)),
            api.database.db
              .select()
              .from(gameCommands)
              .where(eq(gameCommands.gameId, initial.gameId)),
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
              responses: [
                discovery.body,
                denied.body,
                deniedTurn.body,
                duplicate.body,
                first.body,
                second.body,
              ],
              urls: http.requests.map(({ url }) => url),
            }),
          ).not.toContain(PROVIDER_KEY);
          expect(http.transport).toHaveBeenCalledTimes(5);
        },
      );
    });

    it("accepts only the legal third output and persists both invalid attempts", async () => {
      await withProviderApi(
        wire,
        [
          catalog(),
          wire.failure(fixture.firstInvalid),
          wire.completion('{"move":"e2e5"}'),
          wire.completion('{"move":"e2e4"}'),
        ],
        async ({ api, guest, http }) => {
          const initial = await createProviderGame(api, guest, wire, fixture.defaultParameters);
          const response = await turn(api, guest, initial);
          expect(response.statusCode, response.body).toBe(200);
          const accepted = gameSnapshotSchema.parse(response.json());
          expect(accepted).toMatchObject({ state: "active", result: "*" });
          expect(accepted.moves.map(({ uci }) => uci)).toEqual(["e2e4"]);
          const log = await records(api, guest, initial.gameId);
          expect(log.turns).toMatchObject([
            {
              invalidOutputCount: 2,
              acceptedMovePly: 1,
              attempts: [
                {
                  outcome: "model_invalid",
                  error: { code: "model_invalid", reason: fixture.firstInvalid },
                  effectiveParameters: fixture.defaultEffectiveParameters,
                },
                {
                  outcome: "model_invalid",
                  error: { code: "model_invalid", reason: "illegal_move" },
                  effectiveParameters: fixture.defaultEffectiveParameters,
                },
                {
                  outcome: "accepted",
                  error: null,
                  effectiveParameters: fixture.defaultEffectiveParameters,
                },
              ],
            },
          ]);
          expect(
            log.turns[0]!.attempts.map(({ effectiveParameters }) => effectiveParameters),
          ).toEqual(Array.from({ length: 3 }, () => fixture.defaultEffectiveParameters));
          expect(http.transport).toHaveBeenCalledTimes(4);
        },
      );
    });

    it("commits a technical loss on the third invalid output without extra transport retries", async () => {
      await withProviderApi(
        wire,
        [catalog(), ...fixture.technicalLoss.responses()],
        async ({ api, guest, http }) => {
          const initial = await createProviderGame(api, guest, wire, fixture.defaultParameters);
          const response = await turn(api, guest, initial);
          expect(response.statusCode, response.body).toBe(200);
          expect(gameSnapshotSchema.parse(response.json())).toMatchObject({
            state: "completed",
            result: "0-1",
            terminationReason: "model_technical_loss",
            moves: [],
          });
          const log = await records(api, guest, initial.gameId);
          expect(log.turns).toMatchObject([
            {
              invalidOutputCount: 3,
              acceptedMovePly: null,
              attempts: fixture.technicalLoss.reasons.map((reason) => ({
                outcome: "model_invalid",
                error: { code: "model_invalid", reason },
                effectiveParameters: fixture.defaultEffectiveParameters,
              })),
            },
          ]);
          expect(
            log.turns[0]!.attempts.map(({ effectiveParameters }) => effectiveParameters),
          ).toEqual(Array.from({ length: 3 }, () => fixture.defaultEffectiveParameters));
          expect(http.transport).toHaveBeenCalledTimes(4);
        },
      );
    });

    it("pauses on quota failure and retains the output budget across explicit resume/retry", async () => {
      await withProviderApi(
        wire,
        [
          catalog(),
          wire.failure("malformed_output"),
          fixture.quota(),
          catalog(),
          wire.completion('{"move":"e2e4"}'),
        ],
        async ({ api, guest, http, logs }) => {
          const initial = await createProviderGame(api, guest, wire, fixture.defaultParameters);
          const response = await turn(api, guest, initial);
          expect(response.statusCode, response.body).toBe(200);
          const paused = gameSnapshotSchema.parse(response.json());
          expect(paused).toMatchObject({ state: "paused", result: "*", moves: [] });
          expect((await records(api, guest, initial.gameId)).turns).toMatchObject([
            {
              invalidOutputCount: 1,
              acceptedMovePly: null,
              attempts: [
                {
                  outcome: "model_invalid",
                  error: { code: "model_invalid", reason: "malformed_output" },
                },
                { outcome: "provider_error", error: { code: "provider_quota" } },
              ],
            },
          ]);
          expect(http.transport).toHaveBeenCalledTimes(3);
          const resume = await post(
            api,
            guest,
            `/games/${initial.gameId}/lifecycle`,
            control(paused, "resume"),
          );
          expect(resume.statusCode, resume.body).toBe(200);
          expect(http.transport).toHaveBeenCalledTimes(3);
          const retry = await turn(api, guest, gameSnapshotSchema.parse(resume.json()));
          expect(retry.statusCode, retry.body).toBe(200);
          expect(gameSnapshotSchema.parse(retry.json())).toMatchObject({
            state: "active",
            result: "*",
            moves: [{ uci: "e2e4" }],
          });
          const log = await records(api, guest, initial.gameId);
          expect(log.turns).toMatchObject([
            {
              invalidOutputCount: 1,
              acceptedMovePly: 1,
              attempts: [
                { outcome: "model_invalid" },
                { outcome: "provider_error" },
                { outcome: "accepted", error: null },
              ],
            },
          ]);
          expect(
            JSON.stringify({ log, logs, responses: [response.body, resume.body, retry.body] }),
          ).not.toContain(PROVIDER_KEY);
          expect(http.transport).toHaveBeenCalledTimes(5);
        },
      );
    });

    it("propagates the operational deadline and records a provider pause", async () => {
      const entered = Promise.withResolvers<void>();
      let signal: AbortSignal | undefined;
      await withProviderApi(
        wire,
        [
          catalog(),
          (request) =>
            new Promise<Response>((_resolve, reject) => {
              signal = request.signal;
              signal.addEventListener("abort", () => reject(new Error(PROVIDER_KEY)), {
                once: true,
              });
              entered.resolve();
            }),
        ],
        async ({ api, guest, http, logs }) => {
          const initial = await createProviderGame(api, guest, wire, fixture.defaultParameters);
          // Database preparation and discovery must finish before the deadline is advanced.
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          try {
            const pending = turn(api, guest, initial);
            await Promise.race([
              entered.promise,
              pending.then(() => expect.fail("Turn completed before inference transport entry")),
            ]);
            expect(signal?.aborted).toBe(false);
            await vi.advanceTimersByTimeAsync(149);
            expect(signal?.aborted).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            const response = await pending;
            expect(response.statusCode, response.body).toBe(200);
            expect(gameSnapshotSchema.parse(response.json())).toMatchObject({
              state: "paused",
              result: "*",
              moves: [],
            });
            expect(signal?.aborted).toBe(true);
            const log = await records(api, guest, initial.gameId);
            expect(log.turns).toMatchObject([
              {
                invalidOutputCount: 0,
                acceptedMovePly: null,
                attempts: [{ outcome: "provider_error", error: { code: "provider_timeout" } }],
              },
            ]);
            expect(JSON.stringify({ log, logs, response: response.body })).not.toContain(
              PROVIDER_KEY,
            );
            expect(http.transport).toHaveBeenCalledTimes(2);
          } finally {
            vi.useRealTimers();
          }
        },
        { turnMs: 150 },
      );
    });

    it("discards a response arriving after Stop without changing the result or budget", async () => {
      const entered = Promise.withResolvers<void>();
      const result = Promise.withResolvers<Response>();
      await withProviderApi(
        wire,
        [
          catalog(),
          () => {
            entered.resolve();
            return result.promise;
          },
        ],
        async ({ api, guest, http }) => {
          const initial = await createProviderGame(api, guest, wire, fixture.defaultParameters);
          const pending = turn(api, guest, initial);
          try {
            await entered.promise;
            const stopped = await post(
              api,
              guest,
              `/games/${initial.gameId}/lifecycle`,
              control(initial, "abort"),
            );
            expect(stopped.statusCode, stopped.body).toBe(200);
            expect((await records(api, guest, initial.gameId)).turns[0]!.attempts[0]).toMatchObject(
              { outcome: "interrupted" },
            );
            result.resolve(wire.completion('{"move":"e2e4"}'));
            expect((await pending).statusCode).toBe(409);
            expect(await snapshot(api, guest, initial.gameId)).toEqual(
              gameSnapshotSchema.parse(stopped.json()),
            );
            expect(stopped.json()).toMatchObject({ state: "aborted", result: "*", moves: [] });
            expect((await records(api, guest, initial.gameId)).turns).toMatchObject([
              {
                invalidOutputCount: 0,
                acceptedMovePly: null,
                attempts: [{ outcome: "discarded" }],
              },
            ]);
            expect(
              await api.database.db
                .select()
                .from(aiTurnReservations)
                .where(eq(aiTurnReservations.gameId, initial.gameId)),
            ).toEqual([]);
            expect(http.transport).toHaveBeenCalledTimes(2);
          } finally {
            // Release the transport before ApiHarness closes Fastify, even if an assertion failed.
            result.resolve(wire.completion('{"move":"e2e4"}'));
            await pending;
          }
        },
      );
    });
  });
}
