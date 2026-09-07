import { type GameSnapshot, gameSnapshotSchema } from "@neurochess/contracts";
import { gameCommands, turnReservations } from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import type { MockMoveStep } from "../src/providers/mock.js";

import {
  aiCommand,
  controlled,
  createAi,
  discover,
  lifecycle,
  mock,
  records,
  runtime,
  turn,
  white,
} from "./ai-helpers.js";
import { ApiHarness, command, FOOLS_MATE, KNIGHT_CYCLE, snapshot, submit } from "./helpers.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());

const invalid: MockMoveStep = { output: "invalid JSON" };
const providerFailures = [
  "provider_auth",
  "provider_quota",
  "provider_timeout",
  "provider_unavailable",
] as const;

describe("AI retry accounting and manual recovery", () => {
  it.each(providerFailures)(
    "preserves the remaining invalid-output budget across %s failures and explicit retries",
    async (kind) => {
      const provider = mock([
        invalid,
        { output: { move: "e2e5" } },
        { error: { kind } },
        { error: { kind } },
        { output: { move: "e2e4" } },
      ]);
      const api = await harness.createApi({ ai: runtime(provider) });
      const guest = await harness.guest(api);
      const initial = await createAi(api, guest);
      const first = aiCommand(initial);
      const paused = gameSnapshotSchema.parse((await turn(api, guest, first)).json());
      expect(paused).toMatchObject({
        state: "paused",
        version: 1,
        result: "*",
        terminationReason: null,
        fen: initial.fen,
        pgn: initial.pgn,
        moves: [],
      });
      expect(provider.requests).toHaveLength(3);
      const restarted = await harness.createApi({ ai: runtime(provider) });
      expect((await discover(restarted, guest)).json()).toEqual({ snapshot: paused });
      expect((await turn(restarted, guest, first)).json()).toHaveProperty(
        "currentSnapshot",
        paused,
      );
      expect(provider.requests).toHaveLength(3);
      const retry = aiCommand(paused);
      const stillPaused = gameSnapshotSchema.parse((await turn(restarted, guest, retry)).json());
      expect(stillPaused).toEqual({ ...paused, version: 2 });
      expect(provider.requests).toHaveLength(4);
      expect((await turn(api, guest, { ...retry, expectedVersion: 2 })).statusCode).toBe(409);
      const accepted = await turn(restarted, guest, aiCommand(stillPaused));
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json()).toMatchObject({
        state: "paused",
        version: 3,
        result: "*",
        moves: [{ uci: "e2e4" }],
      });
      const stored = await records(api, initial.gameId);
      expect(stored.invocations.map(({ status }) => status)).toEqual([
        "model_invalid",
        "model_invalid",
        "provider_error",
        "provider_error",
        "succeeded",
      ]);
      expect(stored.invocations.map(({ attempt }) => attempt)).toEqual([1, 2, 3, 1, 1]);
      expect(stored.reservations.map(({ status }) => status)).toEqual([
        "committed",
        "committed",
        "committed",
      ]);
      expect(new Set(provider.requests.map(({ context }) => JSON.stringify(context))).size).toBe(1);
    },
  );

  it.each(["white", "black"] as const)(
    "records %s's third invalid output as a technical loss across reservations and pause/resume",
    async (color) => {
      const provider = mock([
        ...(color === "black" ? [{ output: { move: "e2e4" } }] : []),
        invalid,
        { error: { kind: "provider_auth" } },
        invalid,
        { error: { kind: "provider_quota" } },
        invalid,
      ]);
      const api = await harness.createApi({ ai: runtime(provider) });
      const guest = await harness.guest(api);
      let current = await createAi(api, guest);
      if (color === "black") {
        current = gameSnapshotSchema.parse((await turn(api, guest, aiCommand(current))).json());
      }
      const before = current;
      current = gameSnapshotSchema.parse((await turn(api, guest, aiCommand(current))).json());
      current = gameSnapshotSchema.parse((await lifecycle(api, guest, current, "resume")).json());
      const restarted = await harness.createApi({ ai: runtime(provider) });
      current = gameSnapshotSchema.parse((await turn(restarted, guest, aiCommand(current))).json());
      expect(current.state).toBe("paused");
      const last = aiCommand(current);
      const response = await turn(restarted, guest, last);
      expect(response.statusCode, response.body).toBe(200);
      const completed = gameSnapshotSchema.parse(response.json());
      const result = color === "white" ? "0-1" : "1-0";
      expect(completed).toMatchObject({
        state: "completed",
        version: before.version + 4,
        result,
        terminationReason: "model_technical_loss",
        moves: before.moves,
        fen: before.fen,
        legalMoves: [],
      });
      expect(completed.pgn).toContain(`[Result "${result}"]`);
      expect(completed.pgn.endsWith(result)).toBe(true);
      expect(await snapshot(api, guest, before.gameId)).toEqual(completed);
      expect((await turn(api, guest, last)).json()).toHaveProperty("currentSnapshot", completed);
      expect((await turn(api, guest, aiCommand(completed))).json()).toHaveProperty(
        "code",
        "INVALID_GAME_STATE",
      );
      const stored = await records(api, before.gameId);
      expect(stored.invocations.filter(({ status }) => status === "model_invalid")).toHaveLength(3);
      expect(stored.invocations.at(-1)).toMatchObject({ attempt: 1, status: "model_invalid" });
      const receipts = await api.database.db
        .select()
        .from(gameCommands)
        .where(eq(gameCommands.gameId, before.gameId));
      expect(receipts).toContainEqual(
        expect.objectContaining({
          commandId: last.commandId,
          kind: "technical_loss",
          version: completed.version,
        }),
      );
      expect(provider.requests).toHaveLength(color === "white" ? 5 : 6);
      expect((await discover(api, guest)).json()).toEqual({ snapshot: null });
      await createAi(api, guest);
    },
  );

  it("resets the invalid-output budget only after an accepted move, including the same model's next turn", async () => {
    const sequence = ["e2e4", "e7e5", "g1f3"];
    const provider = mock(sequence.flatMap((move) => [invalid, invalid, { output: { move } }]));
    const api = await harness.createApi({ ai: runtime(provider) });
    const guest = await harness.guest(api);
    let current = await createAi(api, guest);
    for (const [index, uci] of sequence.entries()) {
      const response = await turn(api, guest, aiCommand(current));
      expect(response.statusCode, response.body).toBe(200);
      current = gameSnapshotSchema.parse(response.json());
      expect(current.state).toBe("active");
      expect(current.version).toBe(index + 1);
      expect(current.moves.at(-1)?.uci).toBe(uci);
    }
    expect(provider.requests).toHaveLength(9);
  });
});

describe("paused AI stepping", () => {
  it("keeps the stored game paused during provider I/O and commits exactly one move and receipt", async () => {
    const gate = controlled([{ output: { move: "e2e4" } }]);
    const api = await harness.createApi({ ai: runtime(gate.adapter) });
    const other = await harness.createApi({ ai: runtime(gate.adapter) });
    const guest = await harness.guest(api);
    const initial = await createAi(api, guest);
    const paused = gameSnapshotSchema.parse((await lifecycle(api, guest, initial, "pause")).json());
    const request = aiCommand(paused);
    const pending = turn(api, guest, request).then((response) => response);
    try {
      const input = await gate.entered;
      expect(input.context).toMatchObject({
        fen: initial.fen,
        pgn: initial.pgn,
        legalMoves: initial.legalMoves,
      });
      expect(await snapshot(other, guest, initial.gameId)).toEqual(paused);
      expect((await turn(other, guest, request)).statusCode).toBe(409);
      expect((await turn(other, guest, aiCommand(paused))).statusCode).toBe(409);
    } finally {
      gate.release();
    }
    const response = await pending;
    expect(response.statusCode, response.body).toBe(200);
    const stepped = gameSnapshotSchema.parse(response.json());
    expect(stepped).toMatchObject({
      state: "paused",
      version: 2,
      legalMoves: [],
      moves: [{ uci: "e2e4" }],
      turn: "black",
    });
    expect(await snapshot(api, guest, initial.gameId)).toEqual(stepped);
    expect(
      await api.database.db.$count(gameCommands, eq(gameCommands.gameId, initial.gameId)),
    ).toBe(2);
    const fenced = gameSnapshotSchema.parse((await lifecycle(api, guest, stepped, "pause")).json());
    expect(fenced).toEqual({ ...stepped, version: 3 });
    const resumed = gameSnapshotSchema.parse(
      (await lifecycle(api, guest, fenced, "resume")).json(),
    );
    expect(resumed).toMatchObject({ state: "active", version: 4, moves: stepped.moves });
    expect(resumed.legalMoves.length).toBeGreaterThan(0);
    expect(gate.provider.requests).toHaveLength(1);
  });

  it.each([
    { reason: "checkmate", sequence: FOOLS_MATE, result: "0-1" },
    {
      reason: "threefold_repetition",
      sequence: [...KNIGHT_CYCLE, ...KNIGHT_CYCLE],
      result: "1/2-1/2",
    },
  ])(
    "preserves history and completes a paused step at $reason",
    async ({ reason, sequence, result }) => {
      const provider = mock(sequence.map((move) => ({ output: { move } })));
      const api = await harness.createApi({ ai: runtime(provider) });
      const guest = await harness.guest(api);
      let current = await createAi(api, guest);
      current = gameSnapshotSchema.parse((await lifecycle(api, guest, current, "pause")).json());
      for (const [index, uci] of sequence.entries()) {
        const response = await turn(api, guest, aiCommand(current));
        expect(response.statusCode, response.body).toBe(200);
        current = gameSnapshotSchema.parse(response.json());
        expect(current.moves.at(-1)?.uci).toBe(uci);
        expect(current.state).toBe(index === sequence.length - 1 ? "completed" : "paused");
        expect(current.version).toBe(index + 2);
      }
      expect(current).toMatchObject({ state: "completed", result, terminationReason: reason });
      expect(await snapshot(api, guest, current.gameId)).toEqual(current);
    },
  );

  it("steps only the AI seat in AI-versus-human and stops a paused game as aborted", async () => {
    const provider = mock([{ output: { move: "e2e4" } }]);
    const api = await harness.createApi({ ai: runtime(provider) });
    const guest = await harness.guest(api);
    let current = await createAi(api, guest, {
      mode: "ai_vs_human",
      humanColor: "black",
      ai: white,
    });
    current = gameSnapshotSchema.parse((await lifecycle(api, guest, current, "pause")).json());
    current = gameSnapshotSchema.parse((await turn(api, guest, aiCommand(current))).json());
    expect(current).toMatchObject({ state: "paused", turn: "black" });
    expect((await turn(api, guest, aiCommand(current))).statusCode).toBe(403);
    expect((await submit(api, guest, command(current, "e7e5"))).statusCode).toBe(409);
    const stopped = gameSnapshotSchema.parse(
      (await lifecycle(api, guest, current, "abort")).json(),
    );
    expect(stopped).toEqual({
      ...current,
      state: "aborted",
      version: current.version + 1,
      terminationReason: "aborted",
    });
    expect((await turn(api, guest, aiCommand(stopped))).statusCode).toBe(409);
    expect(provider.requests).toHaveLength(1);
    await createAi(api, guest);
  });
});

describe("AI lifecycle completion races and interruptions", () => {
  it.each(["pause", "abort"] as const)(
    "%s prevents an active turn's late third invalid response from recording a loss",
    async (action) => {
      const gate = controlled([invalid, invalid, invalid, { output: { move: "d2d4" } }], 3);
      const api = await harness.createApi({ ai: runtime(gate.adapter) });
      const other = await harness.createApi({ ai: runtime(gate.adapter) });
      const guest = await harness.guest(api);
      const initial = await createAi(api, guest);
      const pending = turn(api, guest, aiCommand(initial)).then((response) => response);
      let current: GameSnapshot;
      try {
        await gate.entered;
        current = gameSnapshotSchema.parse((await lifecycle(other, guest, initial, action)).json());
        if (action === "pause") {
          current = gameSnapshotSchema.parse(
            (await lifecycle(other, guest, current, "resume")).json(),
          );
          const next = await turn(other, guest, aiCommand(current));
          expect(next.statusCode, next.body).toBe(200);
          current = gameSnapshotSchema.parse(next.json());
        }
      } finally {
        gate.release();
      }
      expect((await pending).json()).toMatchObject({
        code: "GAME_CONFLICT",
        currentSnapshot: current,
      });
      expect(await snapshot(api, guest, initial.gameId)).toEqual(current);
      expect(current).toMatchObject({
        state: action === "pause" ? "active" : "aborted",
        result: "*",
        terminationReason: action === "pause" ? null : "aborted",
      });
      const stored = await records(api, initial.gameId);
      expect(stored.invocations.slice(0, 3).map(({ status }) => status)).toEqual([
        "model_invalid",
        "model_invalid",
        "abandoned",
      ]);
      expect(stored.moves).toHaveLength(action === "pause" ? 1 : 0);
      expect(gate.provider.requests).toHaveLength(action === "pause" ? 4 : 3);
    },
  );

  it.each(
    (["pause", "resume", "abort"] as const).flatMap((action) =>
      (["success", "third_invalid", "provider_error"] as const).map((outcome) => ({
        action,
        outcome,
      })),
    ),
  )(
    "$action invalidates a paused step before its $outcome completes",
    async ({ action, outcome }) => {
      const steps: MockMoveStep[] =
        outcome === "third_invalid"
          ? [invalid, invalid, invalid]
          : [
              outcome === "success"
                ? { output: { move: "e2e4" } }
                : { error: { kind: "provider_timeout" } },
            ];
      const gate = controlled([...steps, { output: { move: "d2d4" } }], steps.length);
      const api = await harness.createApi({ ai: runtime(gate.adapter) });
      const other = await harness.createApi({ ai: runtime(gate.adapter) });
      const guest = await harness.guest(api);
      const initial = await createAi(api, guest);
      const paused = gameSnapshotSchema.parse(
        (await lifecycle(api, guest, initial, "pause")).json(),
      );
      const request = aiCommand(paused);
      const pending = turn(api, guest, request).then((response) => response);
      let updated: GameSnapshot;
      try {
        await gate.entered;
        const response = await lifecycle(other, guest, paused, action);
        expect(response.statusCode, response.body).toBe(200);
        updated = gameSnapshotSchema.parse(response.json());
      } finally {
        gate.release();
      }
      expect((await pending).json()).toMatchObject({
        code: "GAME_CONFLICT",
        currentSnapshot: updated,
      });
      const stored = await records(api, initial.gameId);
      expect(stored.moves).toHaveLength(0);
      expect(stored.reservations).toMatchObject([{ status: "cancelled" }]);
      expect(stored.invocations.at(-1)).toMatchObject({
        status: "abandoned",
        latencyMs: null,
        move: null,
      });
      expect(stored.invocations.filter(({ status }) => status === "model_invalid")).toHaveLength(
        outcome === "third_invalid" ? 2 : 0,
      );
      expect(gate.provider.requests).toHaveLength(steps.length);
      expect(
        (await turn(other, guest, { ...request, expectedVersion: updated.version })).statusCode,
      ).toBe(409);
      if (action !== "abort") {
        const next = await turn(other, guest, aiCommand(updated));
        expect(next.statusCode, next.body).toBe(200);
        expect(next.json()).toMatchObject({ state: updated.state, moves: [{ uci: "d2d4" }] });
      }
    },
  );

  it.each(["pause", "abort"] as const)(
    "%s cannot overwrite a provider completion that wins the commit lock",
    async (action) => {
      const provider = mock([{ output: { move: "e2e4" } }]);
      const committed = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const api = await harness.createApi({
        ai: runtime(provider),
        repository: (repository) => ({
          ...repository,
          write: (execute) =>
            repository.write((tx) =>
              execute({
                ...tx,
                async commitAiTurn(owner, accepted) {
                  await tx.commitAiTurn(owner, accepted);
                  committed.resolve();
                  await release.promise;
                },
              }),
            ),
        }),
      });
      const other = await harness.createApi({ ai: runtime(provider) });
      const guest = await harness.guest(api);
      const initial = await createAi(api, guest);
      const pending = turn(api, guest, aiCommand(initial)).then((response) => response);
      let control: ReturnType<typeof lifecycle>;
      try {
        await committed.promise;
        control = lifecycle(other, guest, initial, action).then((response) => response);
      } finally {
        release.resolve();
      }
      const accepted = gameSnapshotSchema.parse((await pending).json());
      expect(accepted).toMatchObject({ state: "active", version: 1, moves: [{ uci: "e2e4" }] });
      expect((await control).json()).toMatchObject({
        code: "GAME_CONFLICT",
        currentSnapshot: accepted,
      });
      expect(await snapshot(other, guest, initial.gameId)).toEqual(accepted);
      expect((await records(other, initial.gameId)).reservations).toMatchObject([
        { status: "committed" },
      ]);
    },
  );

  it("recovers an expired paused reservation with Pause and never repeats its command or counts its pending output", async () => {
    const gate = controlled([invalid, invalid, invalid, invalid], 3);
    const api = await harness.createApi({ ai: runtime(gate.adapter) });
    const other = await harness.createApi({ ai: runtime(gate.adapter) });
    const guest = await harness.guest(api);
    const initial = await createAi(api, guest);
    const paused = gameSnapshotSchema.parse((await lifecycle(api, guest, initial, "pause")).json());
    const request = aiCommand(paused);
    const pending = turn(api, guest, request).then((response) => response);
    let recovered: GameSnapshot;
    try {
      await gate.entered;
      await api.database.db
        .update(turnReservations)
        .set({
          createdAt: sql`clock_timestamp() - interval '2 minutes'`,
          leaseExpiresAt: sql`clock_timestamp() - interval '1 minute'`,
        })
        .where(eq(turnReservations.gameId, initial.gameId));
      expect((await turn(other, guest, aiCommand(paused))).json()).toMatchObject({
        code: "GAME_CONFLICT",
        currentSnapshot: paused,
      });
      expect(await snapshot(other, guest, initial.gameId)).toEqual(paused);
      recovered = gameSnapshotSchema.parse((await lifecycle(other, guest, paused, "pause")).json());
      expect(recovered).toEqual({ ...paused, version: 2 });
    } finally {
      gate.release();
    }
    expect((await pending).statusCode).toBe(409);
    expect((await records(api, initial.gameId)).invocations.map(({ status }) => status)).toEqual([
      "model_invalid",
      "model_invalid",
      "abandoned",
    ]);
    expect((await records(api, initial.gameId)).reservations).toMatchObject([
      { status: "abandoned" },
    ]);
    expect(
      (await turn(other, guest, { ...request, expectedVersion: recovered.version })).statusCode,
    ).toBe(409);
    const response = await turn(other, guest, aiCommand(recovered));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      state: "completed",
      terminationReason: "model_technical_loss",
      moves: [],
    });
    expect(gate.provider.requests).toHaveLength(4);
  });
});
