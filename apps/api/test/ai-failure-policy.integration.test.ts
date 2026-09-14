import { randomUUID } from "node:crypto";

import type { NormalizedMoveResponse, ProviderFailure, TokenUsage } from "@neurochess/contracts";
import {
  aiTurnReservations,
  aiTurns,
  gameCommands,
  type GameRepository,
  modelInvocations,
} from "@neurochess/database";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  access,
  aiMatch,
  control,
  gatedAdapter,
  output,
  service,
  turnCommand,
} from "./ai-turn-helpers.js";
import { ApiHarness, createSandbox } from "./helpers.js";
import { createScriptedAdapter } from "./providers/scripted-adapter.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());

function failure(error: ProviderFailure, usage: TokenUsage | null = null): NormalizedMoveResponse {
  return {
    ok: false,
    error,
    usage,
    durationMs: 987654321,
    providerRequestId: "ignored-upstream-id",
  };
}
const invalid = failure({ code: "model_invalid", reason: "malformed_output" });
const providerFailures: ProviderFailure[] = [
  { code: "provider_auth" },
  { code: "provider_quota" },
  { code: "provider_timeout" },
  ...(["network", "upstream", "invalid_response", "unsupported_model", "cancelled"] as const).map(
    (reason) => ({ code: "provider_unavailable" as const, reason }),
  ),
];

describe("durable AI failure policy and private invocation records", () => {
  it.each([1, 3])(
    "retains invalid output %i when transport cancellation arrives after the response but before its outcome transaction",
    async (invalidNumber) => {
      const api = await harness.createApi();
      const owner = await harness.guest(api);
      const principal = { guestSessionId: owner.id };
      const controller = new AbortController();
      let locks = 0;
      const repository: GameRepository = {
        ...api.repository,
        write: (action) =>
          api.repository.write((tx) =>
            action({
              ...tx,
              async lockGame(gameId) {
                const game = await tx.lockGame(gameId);
                if (++locks === 2 * invalidNumber) controller.abort("transport-secret-sentinel");
                return game;
              },
            }),
          ),
      };
      const adapter = createScriptedAdapter({
        provider: "openai",
        moves: [invalid, invalid, invalid],
      });
      const gamesService = service(api, { openai: adapter }, repository);
      const { snapshot } = await gamesService.createAi(principal, aiMatch);
      const result = await gamesService.aiTurn(
        principal,
        turnCommand(snapshot),
        access(controller.signal),
      );
      expect(result).toMatchObject({
        state: invalidNumber === 3 ? "completed" : "paused",
        version: 1,
        moves: [],
        terminationReason: invalidNumber === 3 ? "model_technical_loss" : null,
      });
      const records = await gamesService.invocations(principal, snapshot.gameId);
      expect(records.turns[0]?.invalidOutputCount).toBe(invalidNumber);
      expect(records.turns[0]?.attempts).toHaveLength(invalidNumber);
      expect(records.turns[0]?.attempts.at(-1)).toMatchObject({
        outcome: "model_invalid",
        error: { code: "model_invalid", reason: "malformed_output" },
      });
      expect(adapter.moveCalls).toBe(invalidNumber);
    },
  );

  it.each([`Credential echo: ${access().apiKey}`, "Unstorable\0commentary"])(
    "omits unsafe optional commentary while accepting its legal move",
    async (commentary) => {
      const api = await harness.createApi();
      const owner = await harness.guest(api);
      const principal = { guestSessionId: owner.id };
      const gamesService = service(api, {
        openai: createScriptedAdapter({ provider: "openai", moves: [output("e2e4", commentary)] }),
      });
      const { snapshot } = await gamesService.createAi(principal, aiMatch);
      const accepted = await gamesService.aiTurn(principal, turnCommand(snapshot), access());
      expect(accepted.moves).toHaveLength(1);
      const records = await gamesService.invocations(principal, snapshot.gameId);
      expect(records.turns[0]?.attempts[0]).toMatchObject({
        outcome: "accepted",
        commentary: null,
      });
      const stored = await api.repository.read((reader) =>
        reader.getModelInvocations(snapshot.gameId),
      );
      expect(JSON.stringify(stored)).not.toContain(access().apiKey);
    },
  );

  it("links invalid-invalid-valid attempts and missing commentary to one accepted move with measured duration and exact parameters", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = { guestSessionId: owner.id };
    const reported = { inputTokens: 0, outputTokens: null, totalTokens: null };
    const contexts: unknown[] = [];
    const adapter = createScriptedAdapter({
      provider: "openai",
      moves: [invalid, { ...output("e2e5"), usage: reported }, output("e2e4")].map(
        (response) => (request) => {
          contexts.push(request.context);
          expect(request.parameters).toEqual(aiMatch.seats.white.parameters);
          return response;
        },
      ),
    });
    const gamesService = service(api, { openai: adapter });
    const { snapshot } = await gamesService.createAi(principal, aiMatch);
    const cmd = turnCommand(snapshot);
    const accepted = await gamesService.aiTurn(principal, cmd, access());
    expect(accepted).toMatchObject({ version: 1, state: "active", moves: [{ uci: "e2e4" }] });
    expect(contexts).toEqual([contexts[0], contexts[0], contexts[0]]);
    const records = await gamesService.invocations(principal, snapshot.gameId);
    expect(records).toMatchObject({
      version: 1,
      turns: [
        {
          ply: 1,
          color: "white",
          invalidOutputCount: 2,
          acceptedMovePly: 1,
          attempts: [
            {
              attemptNumber: 1,
              outcome: "model_invalid",
              error: { code: "model_invalid", reason: "malformed_output" },
              usage: null,
            },
            {
              attemptNumber: 2,
              outcome: "model_invalid",
              error: { code: "model_invalid", reason: "illegal_move" },
              usage: reported,
            },
            { attemptNumber: 3, outcome: "accepted", error: null, commentary: null, usage: null },
          ],
        },
      ],
    });
    for (const attempt of records.turns[0]!.attempts) {
      expect(attempt).toMatchObject({
        commandId: cmd.commandId,
        expectedVersion: 0,
        provider: "openai",
        modelId: "fixture-white",
        effectiveParameters: { temperature: 0 },
      });
      expect(attempt.durationMs).toBeGreaterThanOrEqual(0);
      expect(attempt.durationMs).toBeLessThan(987654321);
    }
    await expect(gamesService.aiTurn(principal, cmd, access())).rejects.toMatchObject({
      code: "GAME_CONFLICT",
    });
    expect(await gamesService.invocations(principal, snapshot.gameId)).toEqual(records);
    expect(adapter.moveCalls).toBe(3);
    const stranger = await harness.guest(api);
    await expect(
      gamesService.invocations({ guestSessionId: stranger.id }, snapshot.gameId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      gamesService.invocations({ guestSessionId: randomUUID() }, snapshot.gameId),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it.each(["white", "black"] as const)(
    "the third invalid output loses only the %s AI seat and releases the shared unfinished slot",
    async (color) => {
      const api = await harness.createApi();
      const owner = await harness.guest(api);
      const principal = { guestSessionId: owner.id };
      const losing = createScriptedAdapter({
        provider: color === "white" ? "openai" : "anthropic",
        moves: [
          invalid,
          failure({ code: "model_invalid", reason: "refusal" }),
          failure({ code: "model_invalid", reason: "truncated_output" }),
        ],
      });
      const gamesService = service(api, {
        openai:
          color === "white"
            ? losing
            : createScriptedAdapter({ provider: "openai", moves: [output("e2e4")] }),
        anthropic: losing,
      });
      let { snapshot } = await gamesService.createAi(principal, aiMatch);
      if (color === "black") {
        snapshot = await gamesService.aiTurn(principal, turnCommand(snapshot), access());
      }
      const cmd = turnCommand(snapshot);
      const terminal = await gamesService.aiTurn(principal, cmd, access());
      expect(terminal).toMatchObject({
        state: "completed",
        result: color === "white" ? "0-1" : "1-0",
        terminationReason: "model_technical_loss",
        version: snapshot.version + 1,
        moves: snapshot.moves,
        fen: snapshot.fen,
      });
      const records = await gamesService.invocations(principal, snapshot.gameId);
      expect(records.turns.at(-1)).toMatchObject({
        color,
        invalidOutputCount: 3,
        acceptedMovePly: null,
      });
      expect(records.turns.at(-1)?.attempts).toHaveLength(3);
      expect(losing.moveCalls).toBe(3);
      expect(
        await api.database.db
          .select()
          .from(gameCommands)
          .where(eq(gameCommands.commandId, cmd.commandId)),
      ).toMatchObject([{ kind: "technical_loss", version: terminal.version }]);
      for (const expectedVersion of [cmd.expectedVersion, terminal.version]) {
        await expect(
          gamesService.aiTurn(principal, { ...cmd, expectedVersion }, access()),
        ).rejects.toMatchObject({ code: "GAME_CONFLICT", currentSnapshot: terminal });
        await expect(
          gamesService.lifecycle(principal, { ...cmd, expectedVersion, action: "abort" }),
        ).rejects.toMatchObject({ code: "GAME_CONFLICT" });
      }
      expect((await gamesService.replay(principal, terminal.gameId)).snapshot).toEqual(terminal);
      expect((await gamesService.pgn(principal, terminal.gameId)).pgn).toBe(terminal.pgn);
      expect((await gamesService.unfinishedGame(principal)).game).toBeNull();
      expect((await createSandbox(api, owner)).gameId).not.toBe(terminal.gameId);
      expect(await gamesService.invocations(principal, terminal.gameId)).toEqual(records);
    },
  );

  it.each(providerFailures)(
    "pauses on $code/$reason with an atomic receipt, retaining the safe cause and no invalid count",
    async (error) => {
      const api = await harness.createApi();
      const owner = await harness.guest(api);
      const principal = { guestSessionId: owner.id };
      const adapter = createScriptedAdapter({
        provider: "openai",
        moves: [failure(error, { inputTokens: 10, outputTokens: 0, totalTokens: null })],
      });
      const gamesService = service(api, { openai: adapter });
      const { snapshot } = await gamesService.createAi(principal, aiMatch);
      const cmd = turnCommand(snapshot);
      const paused = await gamesService.aiTurn(principal, cmd, access());
      expect(paused).toMatchObject({
        state: "paused",
        result: "*",
        terminationReason: null,
        version: 1,
        moves: [],
        fen: snapshot.fen,
      });
      expect(await gamesService.invocations(principal, snapshot.gameId)).toMatchObject({
        turns: [
          {
            invalidOutputCount: 0,
            acceptedMovePly: null,
            attempts: [
              {
                outcome: "provider_error",
                error,
                usage: { inputTokens: 10, outputTokens: 0, totalTokens: null },
              },
            ],
          },
        ],
      });
      expect(
        await api.database.db
          .select()
          .from(gameCommands)
          .where(eq(gameCommands.gameId, snapshot.gameId)),
      ).toMatchObject([{ commandId: cmd.commandId, kind: "pause", version: 1 }]);
      await expect(gamesService.aiTurn(principal, cmd, access())).rejects.toMatchObject({
        code: "GAME_CONFLICT",
      });
      await expect(
        gamesService.aiTurn(principal, turnCommand(paused), access()),
      ).rejects.toMatchObject({ code: "INVALID_GAME_STATE" });
      expect(adapter.moveCalls).toBe(1);
    },
  );

  it.each(["accepted", "technical_loss"] as const)(
    "preserves the same logical budget through a provider pause, process restart and manual retry ending in %s",
    async (ending) => {
      const api = await harness.createApi();
      const owner = await harness.guest(api);
      const principal = { guestSessionId: owner.id };
      const firstAdapter = createScriptedAdapter({
        provider: "openai",
        moves: [invalid, failure({ code: "provider_auth" })],
      });
      const first = service(api, { openai: firstAdapter });
      const { snapshot } = await first.createAi(principal, aiMatch);
      const cmd = turnCommand(snapshot);
      const paused = await first.aiTurn(principal, cmd, access());
      const before = await first.invocations(principal, snapshot.gameId);
      expect(before.turns[0]).toMatchObject({ invalidOutputCount: 1, acceptedMovePly: null });
      await harness.close(api);
      const restarted = await harness.createApi();
      const adapter = createScriptedAdapter({
        provider: "openai",
        moves: [invalid, ending === "accepted" ? output("e2e4", "Viewer commentary") : invalid],
      });
      const recovered = service(restarted, { openai: adapter });
      expect(await recovered.invocations(principal, snapshot.gameId)).toEqual(before);
      await expect(recovered.aiTurn(principal, cmd, access())).rejects.toMatchObject({
        code: "GAME_CONFLICT",
      });
      expect((await recovered.unfinishedGame(principal)).game?.snapshot).toEqual(paused);
      expect(adapter.moveCalls).toBe(0);
      const resumed = await recovered.lifecycle(principal, control(paused, "resume"));
      const final = await recovered.aiTurn(principal, turnCommand(resumed), access());
      expect(final).toMatchObject({
        version: 3,
        state: ending === "accepted" ? "active" : "completed",
      });
      const records = await recovered.invocations(principal, snapshot.gameId);
      expect(records.turns).toHaveLength(1);
      expect(records.turns[0]).toMatchObject({
        id: before.turns[0]?.id,
        invalidOutputCount: ending === "accepted" ? 2 : 3,
        acceptedMovePly: ending === "accepted" ? 1 : null,
      });
      expect(records.turns[0]?.attempts.map((attempt) => attempt.attemptNumber)).toEqual([
        1, 2, 3, 4,
      ]);
      expect(records.turns[0]?.attempts.at(-1)?.commentary).toBe(
        ending === "accepted" ? "Viewer commentary" : null,
      );
      expect(final.pgn).not.toContain("Viewer commentary");
      expect(adapter.moveCalls).toBe(2);
    },
  );

  it.each([
    null,
    { inputTokens: null, outputTokens: null, totalTokens: null },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    { inputTokens: 12, outputTokens: 8, totalTokens: null },
  ])("preserves reported usage exactly: %j", async (usage) => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = { guestSessionId: owner.id };
    const gamesService = service(api, {
      openai: createScriptedAdapter({ provider: "openai", moves: [{ ...output("e2e4"), usage }] }),
    });
    const { snapshot } = await gamesService.createAi(principal, aiMatch);
    await gamesService.aiTurn(principal, turnCommand(snapshot), access());
    expect(
      (await gamesService.invocations(principal, snapshot.gameId)).turns[0]?.attempts[0]?.usage,
    ).toEqual(usage);
  });

  it.each(["accepted", "technical_loss"] as const)(
    "deduplicates attempts across APIs during automatic retries and commits only one %s outcome",
    async (ending) => {
      const api = await harness.createApi();
      const other = await harness.createApi();
      const owner = await harness.guest(api);
      const principal = { guestSessionId: owner.id };
      const entered = Promise.withResolvers<void>();
      const result = Promise.withResolvers<NormalizedMoveResponse>();
      const adapter = createScriptedAdapter({
        provider: "openai",
        moves: [
          invalid,
          invalid,
          () => {
            entered.resolve();
            return result.promise;
          },
        ],
      });
      const gamesService = service(api, { openai: adapter });
      const { snapshot } = await gamesService.createAi(principal, aiMatch);
      const cmd = turnCommand(snapshot);
      const pending = gamesService.aiTurn(principal, cmd, access());
      await entered.promise;
      const second = service(other, { openai: adapter });
      const before = await second.invocations(principal, snapshot.gameId);
      expect(before.turns[0]).toMatchObject({
        invalidOutputCount: 2,
        attempts: [
          { outcome: "model_invalid" },
          { outcome: "model_invalid" },
          { outcome: "in_flight" },
        ],
      });
      for (const duplicate of [cmd, turnCommand(snapshot)]) {
        await expect(second.aiTurn(principal, duplicate, access())).rejects.toMatchObject({
          code: "AI_TURN_IN_PROGRESS",
        });
      }
      result.resolve(ending === "accepted" ? output("e2e4") : invalid);
      const final = await pending;
      await expect(second.aiTurn(principal, cmd, access())).rejects.toMatchObject({
        code: "GAME_CONFLICT",
        currentSnapshot: final,
      });
      expect(adapter.moveCalls).toBe(3);
      const records = await second.invocations(principal, snapshot.gameId);
      expect(records.turns[0]?.attempts).toHaveLength(3);
      expect(
        await other.database.db.$count(gameCommands, eq(gameCommands.gameId, snapshot.gameId)),
      ).toBe(1);
    },
  );

  it("retains a late provider failure after Stop without changing the stopped result, budget or a subsequent game", async () => {
    const api = await harness.createApi();
    const other = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = { guestSessionId: owner.id };
    const gate = gatedAdapter();
    const gamesService = service(api, { openai: gate.adapter });
    const { snapshot } = await gamesService.createAi(principal, aiMatch);
    const pending = gamesService.aiTurn(principal, turnCommand(snapshot), access());
    await gate.entered;
    const stopped = await service(other).lifecycle(principal, control(snapshot, "abort"));
    expect(
      (await gamesService.invocations(principal, snapshot.gameId)).turns[0]?.attempts[0],
    ).toMatchObject({ outcome: "interrupted", usage: null, durationMs: null });
    const next = await service(other).createAi(principal, aiMatch);
    const rejected = expect(pending).rejects.toMatchObject({
      code: "GAME_CONFLICT",
      currentSnapshot: stopped,
    });
    gate.resolve(
      failure(
        { code: "provider_quota" },
        { inputTokens: 4, outputTokens: null, totalTokens: null },
      ),
    );
    await rejected;
    expect(await gamesService.snapshot(principal, snapshot.gameId)).toEqual(stopped);
    expect(await gamesService.snapshot(principal, next.snapshot.gameId)).toEqual(next.snapshot);
    expect(await gamesService.invocations(principal, snapshot.gameId)).toMatchObject({
      turns: [
        {
          invalidOutputCount: 0,
          acceptedMovePly: null,
          attempts: [
            {
              outcome: "discarded",
              error: { code: "provider_quota" },
              usage: { inputTokens: 4, outputTokens: null, totalTokens: null },
            },
          ],
        },
      ],
    });
    expect(
      await api.database.db.$count(gameCommands, eq(gameCommands.gameId, snapshot.gameId)),
    ).toBe(1);
  });

  it.each(["pause", "technical_loss"] as const)(
    "rolls back a failed %s receipt together with the outcome and counters, preserving earlier invalid results for recovery",
    async (ending) => {
      const api = await harness.createApi();
      const owner = await harness.guest(api);
      const principal = { guestSessionId: owner.id };
      const adapter = createScriptedAdapter({
        provider: "openai",
        moves: [
          invalid,
          invalid,
          ending === "pause" ? failure({ code: "provider_auth" }) : invalid,
        ],
      });
      const repository: GameRepository = {
        ...api.repository,
        write: (action) =>
          api.repository.write((tx) =>
            action({
              ...tx,
              async appendCommand(receipt) {
                await tx.appendCommand(receipt);
                if (receipt.kind === ending) throw new Error("Injected outcome receipt failure");
              },
            }),
          ),
      };
      const failing = service(api, { openai: adapter }, repository);
      const { snapshot } = await failing.createAi(principal, aiMatch);
      const cmd = turnCommand(snapshot);
      await expect(failing.aiTurn(principal, cmd, access())).rejects.toThrow(
        "Injected outcome receipt failure",
      );
      const recovered = service(await harness.createApi());
      expect(await recovered.snapshot(principal, snapshot.gameId)).toEqual(snapshot);
      expect(await recovered.invocations(principal, snapshot.gameId)).toMatchObject({
        turns: [
          {
            invalidOutputCount: 2,
            attempts: [
              { outcome: "model_invalid" },
              { outcome: "model_invalid" },
              { outcome: "in_flight" },
            ],
          },
        ],
      });
      expect(
        await api.database.db.$count(gameCommands, eq(gameCommands.gameId, snapshot.gameId)),
      ).toBe(0);
      await expect(recovered.aiTurn(principal, cmd, access())).rejects.toMatchObject({
        code: "AI_TURN_RECOVERY_REQUIRED",
      });
      await recovered.lifecycle(principal, control(snapshot, "pause"));
      expect((await recovered.invocations(principal, snapshot.gameId)).turns[0]).toMatchObject({
        invalidOutputCount: 2,
        attempts: [
          { outcome: "model_invalid" },
          { outcome: "model_invalid" },
          { outcome: "interrupted" },
        ],
      });
      expect(
        await api.database.db.$count(
          aiTurnReservations,
          eq(aiTurnReservations.gameId, snapshot.gameId),
        ),
      ).toBe(0);
    },
  );

  it("rejects inconsistent persisted counters on private reads without changing records", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const principal = { guestSessionId: owner.id };
    const gamesService = service(api, {
      openai: createScriptedAdapter({ provider: "openai", moves: [output("e2e4")] }),
    });
    const { snapshot } = await gamesService.createAi(principal, aiMatch);
    await gamesService.aiTurn(principal, turnCommand(snapshot), access());
    await api.database.db
      .update(aiTurns)
      .set({ invalidOutputCount: 1 })
      .where(eq(aiTurns.gameId, snapshot.gameId));
    await expect(gamesService.invocations(principal, snapshot.gameId)).rejects.toMatchObject({
      code: "GAME_INTEGRITY",
    });
    expect(
      (await api.repository.read((reader) => reader.getAiTurns(snapshot.gameId)))[0]
        ?.invalidOutputCount,
    ).toBe(1);
    expect(await api.database.db.$count(modelInvocations)).toBeGreaterThan(0);
  });
});
