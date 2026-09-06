import { randomUUID } from "node:crypto";

import { createGame } from "@neurochess/chess";
import {
  type AiConfiguration,
  type AiTurnCommand,
  type CreateAiGameRequest,
  type GameSnapshot,
  gameSnapshotSchema,
  type ModelDescriptor,
  type NormalizedMoveResponse,
} from "@neurochess/contracts";
import {
  gameCommands,
  gameParticipants,
  games,
  guestSessions,
  moves,
  turnReservations,
} from "@neurochess/database";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import type { AiGameOptions } from "../src/games/ai-service.js";
import { createLoggerOptions } from "../src/logger.js";
import type { AiProviderAdapter, MoveRequest } from "../src/providers/adapter.js";
import { createScriptedMockProvider, type MockMoveStep } from "../src/providers/mock.js";

import {
  ApiHarness,
  command,
  createSandbox,
  FOOLS_MATE,
  snapshot,
  submit,
  type TestApi,
  type TestGuest,
  WEB_ORIGIN,
} from "./helpers.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());

const model: ModelDescriptor = {
  provider: "openai",
  id: "fixture-model",
  name: "Fixture model",
  supportedParameters: {
    temperature: { min: 0, max: 2 },
    maxOutputTokens: { min: 16, max: 4096 },
  },
};
const white: AiConfiguration = {
  provider: model.provider,
  modelId: model.id,
  parameters: { temperature: 0 },
};
const black: AiConfiguration = { ...white, parameters: { temperature: 1.5, maxOutputTokens: 100 } };
const creation: CreateAiGameRequest = { mode: "ai_vs_ai", white, black };

function mock(steps: readonly MockMoveStep[]) {
  return createScriptedMockProvider({
    descriptor: { id: "openai", name: "Fixture provider" },
    models: [model],
    moves: steps,
  });
}

function runtime(adapter: AiProviderAdapter, leaseMs?: number): AiGameOptions {
  return {
    providers: [{ adapter, models: [model] }],
    ...(leaseMs === undefined ? {} : { leaseMs }),
  };
}

function controlled(steps: readonly MockMoveStep[]) {
  const provider = mock(steps);
  const entered = Promise.withResolvers<MoveRequest>();
  const release = Promise.withResolvers<void>();
  let first = true;
  const adapter: AiProviderAdapter = {
    ...provider,
    async requestMove(input) {
      const result = await provider.requestMove(input);
      if (first) {
        first = false;
        entered.resolve(input);
        await release.promise;
      }
      return result;
    },
  };
  return { provider, adapter, entered: entered.promise, release: () => release.resolve() };
}

function post(api: TestApi, guest: TestGuest, url: string, payload: unknown) {
  return api.app.inject({
    method: "POST",
    url,
    payload: payload as object,
    headers: { origin: WEB_ORIGIN, cookie: guest.cookie },
  });
}

async function createAi(api: TestApi, guest: TestGuest, request: CreateAiGameRequest = creation) {
  const response = await post(api, guest, "/ai/games", request);
  expect(response.statusCode, response.body).toBe(201);
  return gameSnapshotSchema.parse(response.json());
}

function aiCommand(current: GameSnapshot): AiTurnCommand {
  return { gameId: current.gameId, expectedVersion: current.version, commandId: randomUUID() };
}

function turn(api: TestApi, guest: TestGuest, request: AiTurnCommand) {
  return post(api, guest, `/games/${request.gameId}/ai-turn`, request);
}

function lifecycle(
  api: TestApi,
  guest: TestGuest,
  current: GameSnapshot,
  action: "pause" | "resume" | "abort" | "resign",
  losingColor?: "white" | "black",
) {
  return post(api, guest, `/games/${current.gameId}/lifecycle`, {
    ...aiCommand(current),
    action,
    ...(losingColor ? { losingColor } : {}),
  });
}

function discover(api: TestApi, guest: TestGuest) {
  return api.app.inject({
    method: "GET",
    url: "/ai/games/unfinished",
    headers: { cookie: guest.cookie },
  });
}

async function records(api: TestApi, gameId: string) {
  return api.repository.read(async (reader) => ({
    game: await reader.getGame(gameId),
    participants: await reader.getParticipants(gameId),
    moves: await reader.getMoves(gameId),
    invocations: await reader.getModelInvocations(gameId),
    reservations: await reader.getTurnReservations(gameId),
  }));
}

describe("guest AI creation, discovery, and authority", () => {
  it("persists independent effective seats and completes an AI match through real routes, service, and database", async () => {
    const provider = mock(
      FOOLS_MATE.map((move) => ({ output: { move, commentary: "private-viewer-commentary" } })),
    );
    const api = await harness.createApi({ sandboxEnabled: false, ai: runtime(provider) });
    const guest = await harness.guest(api);
    expect((await discover(api, guest)).json()).toEqual({ snapshot: null });
    let current = await createAi(api, guest, {
      ...creation,
      white: { ...white, parameters: { temperature: 0, reasoningEffort: "unsupported" } },
    });
    const gameId = current.gameId;
    const started = createGame().start();
    if (!started.ok) throw new Error("Initial game fixture failed");
    expect(current).toEqual({ ...started.value, gameId, version: 0 });
    const stored = await records(api, gameId);
    expect(stored.game).toMatchObject({
      mode: "ai_vs_ai",
      isSandbox: false,
      ownerGuestSessionId: guest.id,
    });
    expect(stored.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          color: "white",
          seatType: "ai",
          provider: "openai",
          modelId: model.id,
          temperature: 0,
          reasoningEffort: null,
          guestSessionId: null,
        }),
        expect.objectContaining({
          color: "black",
          seatType: "ai",
          temperature: 1.5,
          maxOutputTokens: 100,
          guestSessionId: null,
        }),
      ]),
    );
    const discovery = await discover(api, guest);
    expect(discovery.headers["cache-control"]).toBe("no-store");
    expect(discovery.json()).toEqual({ snapshot: current });
    const restarted = await harness.createApi({ sandboxEnabled: false, ai: runtime(provider) });
    for (const [index, uci] of FOOLS_MATE.entries()) {
      const before = current;
      const request = aiCommand(before);
      const response = await turn(restarted, guest, request);
      expect(response.statusCode, response.body).toBe(200);
      current = gameSnapshotSchema.parse(response.json());
      expect(current.version).toBe(index + 1);
      expect(current.moves.at(-1)?.uci).toBe(uci);
      expect(current).toEqual(await snapshot(api, guest, gameId));
      expect(provider.requests[index]).toMatchObject({
        configuration: index % 2 === 0 ? white : black,
        context: {
          fen: before.fen,
          pgn: before.pgn,
          legalMoves: before.legalMoves,
          color: before.turn,
          sideToMove: before.turn,
        },
      });
      expect((await turn(api, guest, request)).json()).toMatchObject({
        code: "GAME_CONFLICT",
        currentSnapshot: current,
      });
    }
    expect(current).toMatchObject({
      state: "completed",
      result: "0-1",
      terminationReason: "checkmate",
    });
    expect((await discover(api, guest)).json()).toEqual({ snapshot: null });
    expect((await records(api, gameId)).reservations.map((row) => row.status)).toEqual([
      "committed",
      "committed",
      "committed",
      "committed",
    ]);
    expect((await records(api, gameId)).invocations.map((row) => row.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(await api.database.db.$count(gameCommands, eq(gameCommands.gameId, gameId))).toBe(4);
    expect(JSON.stringify(provider.requests)).not.toContain("private-viewer-commentary");
    expect(JSON.stringify(provider.requests)).not.toContain("apiKey");
    expect(provider.requests).toHaveLength(4);
    const replay = await api.app.inject({
      method: "GET",
      url: `/games/${gameId}/replay`,
      headers: { cookie: guest.cookie },
    });
    expect(replay.json()).toHaveProperty("snapshot", current);
    await createAi(api, guest);
    expect(await snapshot(api, guest, gameId)).toEqual(current);
  });

  it.each(["white", "black"] as const)(
    "assigns only the selected %s human seat and validates both kinds of turn",
    async (humanColor) => {
      const provider = mock([{ output: { move: humanColor === "white" ? "e7e5" : "e2e4" } }]);
      const api = await harness.createApi({ ai: runtime(provider) });
      const guest = await harness.guest(api);
      let current = await createAi(api, guest, { mode: "ai_vs_human", humanColor, ai: white });
      const aiColor = humanColor === "white" ? "black" : "white";
      expect(
        (await records(api, current.gameId)).participants.find((seat) => seat.color === humanColor),
      ).toMatchObject({ seatType: "human", guestSessionId: guest.id, provider: null });
      expect((await lifecycle(api, guest, current, "resign", aiColor)).statusCode).toBe(403);
      if (humanColor === "white") {
        expect((await turn(api, guest, aiCommand(current))).statusCode).toBe(403);
        const response = await submit(api, guest, command(current, "e2e4"));
        expect(response.statusCode).toBe(200);
        current = gameSnapshotSchema.parse(response.json());
      }
      expect((await submit(api, guest, command(current, current.legalMoves[0]!))).statusCode).toBe(
        403,
      );
      const response = await turn(api, guest, aiCommand(current));
      expect(response.statusCode, response.body).toBe(200);
      current = gameSnapshotSchema.parse(response.json());
      expect(current.turn).toBe(humanColor);
      expect((await turn(api, guest, aiCommand(current))).statusCode).toBe(403);
      const human = await submit(
        api,
        guest,
        command(current, humanColor === "white" ? "g1f3" : "e7e5"),
      );
      expect(human.statusCode).toBe(200);
      expect(provider.requests).toHaveLength(1);
    },
  );

  it("keeps AI reads private, owner controls separate, and discovery read-only across pause/resume", async () => {
    const provider = mock([]);
    const api = await harness.createApi({ sandboxEnabled: false, ai: runtime(provider) });
    const owner = await harness.guest(api);
    const stranger = await harness.guest(api);
    const current = await createAi(api, owner, {
      mode: "ai_vs_human",
      humanColor: "black",
      ai: white,
    });
    for (const suffix of ["", "/replay", "/pgn"]) {
      const denied = await api.app.inject({
        method: "GET",
        url: `/games/${current.gameId}${suffix}`,
        headers: { cookie: stranger.cookie },
      });
      expect(denied.statusCode).toBe(404);
      expect(denied.json()).not.toHaveProperty("currentSnapshot");
    }
    expect((await turn(api, stranger, aiCommand(current))).statusCode).toBe(404);
    expect((await lifecycle(api, stranger, current, "pause")).statusCode).toBe(404);
    expect((await discover(api, stranger)).json()).toEqual({ snapshot: null });
    const pause = await lifecycle(api, owner, current, "pause");
    const paused = gameSnapshotSchema.parse(pause.json());
    expect((await discover(api, owner)).json()).toEqual({ snapshot: paused });
    expect((await turn(api, owner, aiCommand(paused))).statusCode).toBe(409);
    expect((await post(api, owner, "/ai/games", creation)).json()).toHaveProperty(
      "currentSnapshot",
      paused,
    );
    const resumed = gameSnapshotSchema.parse(
      (await lifecycle(api, owner, paused, "resume")).json(),
    );
    // A readable participant is still not the owner and cannot execute an AI turn or control lifecycle.
    const human = (await records(api, current.gameId)).participants.find(
      (seat) => seat.seatType === "human",
    )!;
    await api.database.db
      .update(gameParticipants)
      .set({ guestSessionId: stranger.id })
      .where(eq(gameParticipants.id, human.id));
    expect(await snapshot(api, stranger, current.gameId)).toEqual(resumed);
    expect((await turn(api, stranger, aiCommand(resumed))).statusCode).toBe(403);
    expect((await lifecycle(api, stranger, resumed, "pause")).statusCode).toBe(403);
    const resigned = await lifecycle(api, stranger, resumed, "resign", "black");
    expect(resigned.statusCode).toBe(200);
    expect(resigned.json()).toMatchObject({
      state: "completed",
      result: "1-0",
      terminationReason: "human_resignation",
    });
    expect(provider.requests).toHaveLength(0);
  });

  it("shares the unfinished slot across AI modes and sandbox creation in independent pools", async () => {
    const provider = mock([]);
    const api = await harness.createApi({ ai: runtime(provider) });
    const other = await harness.createApi({ ai: runtime(provider) });
    const guest = await harness.guest(api);
    const responses = await Promise.all([
      post(api, guest, "/ai/games", creation),
      post(other, guest, "/ai/games", { mode: "ai_vs_human", humanColor: "black", ai: white }),
      post(other, guest, "/sandbox/games", {}),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409, 409]);
    const current = gameSnapshotSchema.parse(
      responses.find((response) => response.statusCode === 201)!.json(),
    );
    for (const response of responses.filter((response) => response.statusCode === 409)) {
      expect(response.json()).toHaveProperty("currentSnapshot", current);
    }
    expect(await api.database.db.$count(games, eq(games.ownerGuestSessionId, guest.id))).toBe(1);
    await lifecycle(api, guest, current, "abort");
    const sandbox = await createSandbox(api, guest);
    expect((await discover(api, guest)).json()).toEqual({ snapshot: null });
    expect((await turn(api, guest, aiCommand(sandbox))).json()).toHaveProperty(
      "code",
      "INVALID_GAME_STATE",
    );
  });
});

describe("authoritative AI execution ownership", () => {
  it("reserves before calling out and rejects duplicates and competing executions across independent pools", async () => {
    const gate = controlled([{ output: { move: "e2e4" } }]);
    const api = await harness.createApi({ ai: runtime(gate.adapter) });
    const other = await harness.createApi({ ai: runtime(gate.adapter) });
    const guest = await harness.guest(api);
    const current = await createAi(api, guest);
    const request = aiCommand(current);
    const pending = turn(api, guest, request).then((response) => response);
    try {
      await gate.entered;
      const held = await records(other, current.gameId);
      expect(held.invocations).toMatchObject([{ status: "pending", attempt: 1 }]);
      expect(held.reservations).toMatchObject([
        { status: "reserved", commandId: request.commandId },
      ]);
      expect(held.moves).toEqual([]);
      expect(
        await other.database.db.$count(gameCommands, eq(gameCommands.gameId, current.gameId)),
      ).toBe(0);
      const duplicates = await Promise.all([
        turn(other, guest, request),
        turn(other, guest, { ...request, commandId: request.commandId.toUpperCase() }),
        turn(other, guest, aiCommand(current)),
        post(other, guest, `/games/${current.gameId}/lifecycle`, { ...request, action: "pause" }),
        submit(other, guest, { ...request, move: "d2d4" }),
      ]);
      for (const response of duplicates) {
        expect(response.statusCode).toBe(409);
        expect(response.json()).toHaveProperty("currentSnapshot", current);
      }
      expect(gate.provider.requests).toHaveLength(1);
    } finally {
      gate.release();
    }
    const accepted = await pending;
    expect(accepted.statusCode, accepted.body).toBe(200);
    const result = await records(other, current.gameId);
    expect(result.moves).toMatchObject([{ uci: "e2e4", version: 1, commandId: request.commandId }]);
    expect(result.reservations).toMatchObject([{ status: "committed" }]);
    expect(
      await other.database.db.$count(gameCommands, eq(gameCommands.gameId, current.gameId)),
    ).toBe(1);
    const retry = await turn(other, guest, { ...request, expectedVersion: 1 });
    expect(retry.statusCode).toBe(409);
    expect(gate.provider.requests).toHaveLength(1);
  });

  it.each(["pause", "abort", "resign"] as const)(
    "allows %s while the provider is pending and rejects the late result",
    async (action) => {
      const gate = controlled([{ output: { move: "e2e4" } }]);
      const api = await harness.createApi({ ai: runtime(gate.adapter) });
      const other = await harness.createApi({ ai: runtime(gate.adapter) });
      const guest = await harness.guest(api);
      const initial = await createAi(api, guest, {
        mode: "ai_vs_human",
        humanColor: "black",
        ai: white,
      });
      const request = aiCommand(initial);
      const pending = turn(api, guest, request).then((response) => response);
      let updated: GameSnapshot;
      try {
        await gate.entered;
        const response = await lifecycle(
          other,
          guest,
          initial,
          action,
          action === "resign" ? "black" : undefined,
        );
        expect(response.statusCode, response.body).toBe(200);
        updated = gameSnapshotSchema.parse(response.json());
      } finally {
        gate.release();
      }
      const late = await pending;
      expect(late.statusCode).toBe(409);
      expect(late.json()).toHaveProperty("currentSnapshot", updated);
      const stored = await records(api, initial.gameId);
      expect(stored.moves).toHaveLength(0);
      expect(stored.game?.version).toBe(1);
      expect(stored.reservations).toMatchObject([{ status: "cancelled" }]);
      expect(stored.invocations).toMatchObject([{ status: "abandoned", move: null }]);
      expect((await turn(api, guest, { ...request, expectedVersion: 1 })).json()).toHaveProperty(
        "code",
        "GAME_CONFLICT",
      );
    },
  );

  it("renews a live attached execution without letting another request take it over", async () => {
    const gate = controlled([{ output: { move: "e2e4" } }]);
    const api = await harness.createApi({ ai: runtime(gate.adapter, 1500) });
    const guest = await harness.guest(api);
    const initial = await createAi(api, guest);
    const pending = turn(api, guest, aiCommand(initial)).then((response) => response);
    try {
      await gate.entered;
      const first = (await records(api, initial.gameId)).reservations[0]!;
      await expect
        .poll(
          async () =>
            (await records(api, initial.gameId)).reservations[0]!.leaseExpiresAt.getTime(),
          { timeout: 5000 },
        )
        .toBeGreaterThan(first.leaseExpiresAt.getTime() + 1500);
      expect((await turn(api, guest, aiCommand(initial))).statusCode).toBe(409);
    } finally {
      gate.release();
    }
    expect((await pending).statusCode).toBe(200);
    expect(gate.provider.requests).toHaveLength(1);
  });

  it("requires explicit pause/resume after expiry and never reuses an abandoned command", async () => {
    const gate = controlled([{ output: { move: "e2e4" } }, { output: { move: "d2d4" } }]);
    const api = await harness.createApi({ ai: runtime(gate.adapter) });
    const guest = await harness.guest(api);
    const initial = await createAi(api, guest);
    const request = aiCommand(initial);
    const pending = turn(api, guest, request).then((response) => response);
    try {
      await gate.entered;
      await api.database.db
        .update(turnReservations)
        .set({
          createdAt: sql`clock_timestamp() - interval '2 minutes'`,
          leaseExpiresAt: sql`clock_timestamp() - interval '1 minute'`,
        })
        .where(eq(turnReservations.gameId, initial.gameId));
      expect((await turn(api, guest, aiCommand(initial))).statusCode).toBe(409);
      expect((await discover(api, guest)).json()).toEqual({ snapshot: initial });
    } finally {
      gate.release();
    }
    expect((await pending).statusCode).toBe(409);
    const paused = gameSnapshotSchema.parse((await lifecycle(api, guest, initial, "pause")).json());
    expect((await records(api, initial.gameId)).reservations).toMatchObject([
      { status: "abandoned" },
    ]);
    const resumed = gameSnapshotSchema.parse(
      (await lifecycle(api, guest, paused, "resume")).json(),
    );
    expect(
      (await turn(api, guest, { ...request, expectedVersion: resumed.version })).json(),
    ).toHaveProperty("code", "GAME_CONFLICT");
    expect((await turn(api, guest, aiCommand(resumed))).json()).toMatchObject({
      version: 3,
      moves: [{ uci: "d2d4" }],
    });
    expect(gate.provider.requests).toHaveLength(2);
  });

  it("stops renewal on a real HTTP disconnect and rejects the late adapter result", async () => {
    const gate = controlled([{ output: { move: "e2e4" } }, { output: { move: "d2d4" } }]);
    const api = await harness.createApi({ ai: runtime(gate.adapter, 1500) });
    const guest = await harness.guest(api);
    const initial = await createAi(api, guest);
    const address = await api.app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const request = aiCommand(initial);
    const disconnected = fetch(`${address}/games/${initial.gameId}/ai-turn`, {
      method: "POST",
      headers: { origin: WEB_ORIGIN, cookie: guest.cookie, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    }).then(
      () => false,
      () => true,
    );
    try {
      const input = await gate.entered;
      controller.abort();
      expect(await disconnected).toBe(true);
      await expect.poll(() => input.signal?.aborted).toBe(true);
      const expiry = (await records(api, initial.gameId)).reservations[0]!.leaseExpiresAt.getTime();
      await expect.poll(() => Date.now(), { timeout: 5000 }).toBeGreaterThan(expiry + 50);
      expect((await records(api, initial.gameId)).reservations[0]!.leaseExpiresAt.getTime()).toBe(
        expiry,
      );
      expect((await turn(api, guest, request)).statusCode).toBe(409);
      expect((await turn(api, guest, aiCommand(initial))).statusCode).toBe(409);
    } finally {
      controller.abort();
      gate.release();
    }
    const paused = gameSnapshotSchema.parse((await lifecycle(api, guest, initial, "pause")).json());
    const resumed = gameSnapshotSchema.parse(
      (await lifecycle(api, guest, paused, "resume")).json(),
    );
    const response = await turn(api, guest, aiCommand(resumed));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ moves: [{ uci: "d2d4" }], version: 3 });
    expect(gate.provider.requests).toHaveLength(2);
  });

  it("rolls back creation and releases the slot if participant insertion fails after SQL writes", async () => {
    const provider = mock([]);
    const api = await harness.createApi({
      ai: runtime(provider),
      repository: (repository) => ({
        ...repository,
        write: (action) =>
          repository.write((tx) =>
            action({
              ...tx,
              async insertGame(game, participants) {
                await tx.insertGame(game, participants);
                throw new Error("fixture-after-participant-insert");
              },
            }),
          ),
      }),
    });
    const guest = await harness.guest(api);
    expect((await post(api, guest, "/ai/games", creation)).statusCode).toBe(500);
    expect((await discover(api, guest)).json()).toEqual({ snapshot: null });
    expect(await api.database.db.$count(games, eq(games.ownerGuestSessionId, guest.id))).toBe(0);
    const other = await harness.createApi({ ai: runtime(provider) });
    await createAi(other, guest);
  });

  it("rolls back the outcome, move, receipt, and aggregate after an actual commit write fails", async () => {
    const provider = mock([{ output: { move: "e2e4" } }]);
    const api = await harness.createApi({
      ai: runtime(provider),
      repository: (repository) => ({
        ...repository,
        write: (action) =>
          repository.write((tx) =>
            action({
              ...tx,
              async commitAiTurn(owner, accepted) {
                await tx.commitAiTurn(owner, accepted);
                throw new Error("fixture-after-actual-ai-write");
              },
            }),
          ),
      }),
    });
    const guest = await harness.guest(api);
    const initial = await createAi(api, guest);
    const request = aiCommand(initial);
    expect((await turn(api, guest, request)).statusCode).toBe(500);
    expect(await snapshot(api, guest, initial.gameId)).toEqual(initial);
    expect(
      await api.database.db.$count(gameCommands, eq(gameCommands.gameId, initial.gameId)),
    ).toBe(0);
    expect(await api.database.db.$count(moves, eq(moves.gameId, initial.gameId))).toBe(0);
    const stored = await records(api, initial.gameId);
    expect(stored.invocations).toMatchObject([{ status: "pending", move: null }]);
    expect(stored.reservations).toMatchObject([{ status: "reserved" }]);
    expect((await turn(api, guest, request)).statusCode).toBe(409);
    expect(provider.requests).toHaveLength(1);
  });
});

describe("AI legality and failure boundaries", () => {
  it("retries model-invalid output within one reservation and records only a legal accepted move", async () => {
    const provider = mock([
      { output: "not JSON" },
      { output: { move: "e2e5" } },
      {
        output: { move: "e2e4" },
        telemetry: {
          latencyMs: 12.5,
          usage: { inputTokens: 0, outputTokens: null, totalTokens: null },
        },
      },
    ]);
    const api = await harness.createApi({ ai: runtime(provider) });
    const guest = await harness.guest(api);
    const initial = await createAi(api, guest);
    const response = await turn(api, guest, aiCommand(initial));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ version: 1, moves: [{ uci: "e2e4" }] });
    const stored = await records(api, initial.gameId);
    expect(stored.invocations).toMatchObject([
      { attempt: 1, status: "model_invalid", invalidReason: "malformed_output", move: null },
      { attempt: 2, status: "model_invalid", invalidReason: "illegal_move", move: null },
      {
        attempt: 3,
        status: "succeeded",
        move: "e2e4",
        commentary: null,
        latencyMs: 12.5,
        inputTokens: 0,
        outputTokens: null,
        usageReported: true,
      },
    ]);
    expect(stored.reservations).toHaveLength(1);
    expect(new Set(provider.requests.map((request) => JSON.stringify(request.context))).size).toBe(
      1,
    );
  });

  it("independently rejects an adapter's illegal success and awards a technical loss only after three invalid attempts", async () => {
    const provider = mock([]);
    let calls = 0;
    const adapter: AiProviderAdapter = {
      ...provider,
      async requestMove(): Promise<NormalizedMoveResponse> {
        calls++;
        return { ok: true, value: { move: "e2e5", latencyMs: 0, usage: null } };
      },
    };
    const api = await harness.createApi({ ai: runtime(adapter) });
    const guest = await harness.guest(api);
    const initial = await createAi(api, guest);
    const response = await turn(api, guest, aiCommand(initial));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      version: 1,
      state: "completed",
      result: "0-1",
      terminationReason: "model_technical_loss",
      moves: [],
    });
    expect(calls).toBe(3);
    const stored = await records(api, initial.gameId);
    expect(stored.invocations.map((row) => row.status)).toEqual([
      "model_invalid",
      "model_invalid",
      "model_invalid",
    ]);
    expect((await discover(api, guest)).json()).toEqual({ snapshot: null });
    await createAi(api, guest);
  });

  it.each(["provider_auth", "provider_quota", "provider_timeout", "provider_unavailable"] as const)(
    "pauses for %s without retrying or recording a technical loss",
    async (kind) => {
      const provider = mock([{ error: { kind } }]);
      const api = await harness.createApi({ ai: runtime(provider) });
      const guest = await harness.guest(api);
      const initial = await createAi(api, guest);
      const response = await turn(api, guest, aiCommand(initial));
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        version: 1,
        state: "paused",
        fen: initial.fen,
        pgn: initial.pgn,
        result: "*",
        terminationReason: null,
        moves: [],
      });
      expect((await records(api, initial.gameId)).invocations).toMatchObject([
        { status: "provider_error", errorKind: kind },
      ]);
      expect(provider.requests).toHaveLength(1);
    },
  );

  it("rejects stale versions, corrupted history, and expired ownership before another provider call", async () => {
    const gate = controlled([{ output: { move: "e2e4" } }]);
    const api = await harness.createApi({ ai: runtime(gate.adapter) });
    const guest = await harness.guest(api);
    const initial = await createAi(api, guest);
    expect((await turn(api, guest, { ...aiCommand(initial), expectedVersion: 1 })).statusCode).toBe(
      409,
    );
    await api.database.db.update(games).set({ fen: "corrupt" }).where(eq(games.id, initial.gameId));
    const corrupt = await turn(api, guest, aiCommand(initial));
    expect(corrupt.statusCode).toBe(500);
    expect(corrupt.body).not.toContain("corrupt");
    expect(gate.provider.requests).toHaveLength(0);
    await api.database.db
      .update(games)
      .set({ fen: initial.fen })
      .where(eq(games.id, initial.gameId));
    const pending = turn(api, guest, aiCommand(initial)).then((response) => response);
    try {
      await gate.entered;
      await api.database.db
        .update(guestSessions)
        .set({
          lastSeenAt: sql`clock_timestamp() - interval '2 hours'`,
          expiresAt: sql`clock_timestamp() - interval '1 hour'`,
        })
        .where(eq(guestSessions.id, guest.id));
    } finally {
      gate.release();
    }
    expect((await pending).statusCode).toBe(401);
    expect((await records(api, initial.gameId)).moves).toHaveLength(0);
  });

  it("validates HTTP boundaries, rejects raw credentials, and does not register a default production mock", async () => {
    const provider = mock([]);
    const api = await harness.createApi({ ai: runtime(provider) });
    const guest = await harness.guest(api);
    expect(
      (
        await api.app.inject({
          method: "POST",
          url: "/ai/games",
          payload: creation,
          headers: { origin: WEB_ORIGIN },
        })
      ).statusCode,
    ).toBe(401);
    expect((await api.app.inject({ method: "GET", url: "/ai/games/unfinished" })).statusCode).toBe(
      401,
    );
    expect(
      (
        await api.app.inject({
          method: "POST",
          url: "/ai/games",
          payload: creation,
          headers: { cookie: guest.cookie, origin: "http://untrusted.test" },
        })
      ).statusCode,
    ).toBe(403);
    for (const payload of [
      { ...creation, isSandbox: true },
      { ...creation, mode: "human_vs_human" },
      { ...creation, white: { ...white, apiKey: "secret-canary" } },
      { ...creation, white: { ...white, parameters: { temperature: 3 } } },
      { ...creation, white: { ...white, modelId: "unknown-model" } },
    ]) {
      expect((await post(api, guest, "/ai/games", payload)).statusCode).toBe(400);
    }
    expect(await api.database.db.$count(games, eq(games.ownerGuestSessionId, guest.id))).toBe(0);
    const initial = await createAi(api, guest);
    const request = aiCommand(initial);
    expect((await post(api, guest, `/games/${randomUUID()}/ai-turn`, request)).statusCode).toBe(
      400,
    );
    expect(
      (await post(api, guest, `/games/${initial.gameId}/ai-turn`, { ...request, move: "e2e4" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post(api, guest, `/games/${initial.gameId}/ai-turn?apiKey=secret-canary`, request))
        .statusCode,
    ).toBe(400);
    const production = await harness.createApi({ nodeEnv: "production", sandboxEnabled: false });
    const other = await harness.guest(production);
    expect((await post(production, other, "/ai/games", creation)).statusCode).toBe(404);
    expect((await turn(production, guest, request)).statusCode).toBe(404);
    expect(provider.requests).toHaveLength(0);
  });

  it("never logs or returns unexpected provider payloads and never automatically repeats an uncertain execution", async () => {
    const chunks: string[] = [];
    const canary = "secret-provider-canary";
    const provider = mock([]);
    const adapter: AiProviderAdapter = {
      ...provider,
      async requestMove() {
        throw Object.assign(new Error(canary), { code: canary, request: { apiKey: canary } });
      },
    };
    const api = await harness.createApi({
      ai: runtime(adapter),
      logger: {
        ...createLoggerOptions("info"),
        stream: {
          write: (chunk: string) => {
            chunks.push(chunk);
          },
        },
      },
    });
    const guest = await harness.guest(api);
    const initial = await createAi(api, guest);
    const request = aiCommand(initial);
    const failed = await turn(api, guest, request);
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain(canary);
    expect(chunks.join("")).not.toContain(canary);
    expect(JSON.stringify(await records(api, initial.gameId))).not.toContain(canary);
    expect((await turn(api, guest, request)).statusCode).toBe(409);
  });
});
