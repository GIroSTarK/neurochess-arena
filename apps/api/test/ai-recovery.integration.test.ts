import { randomUUID } from "node:crypto";

import {
  aiGameResponseSchema,
  aiRuntimeHeader,
  type CreateAiGameRequest,
  type GameSnapshot,
  gameSnapshotSchema,
} from "@neurochess/contracts";
import type { AiReservationOwner } from "@neurochess/database";
import { afterEach, describe, expect, it } from "vitest";

import { FIFTY_MOVE_HISTORY } from "../../../packages/chess/test/fixtures.js";

import {
  aiCommand,
  createAi,
  creation,
  credential,
  lifecycle,
  mock,
  post,
  records,
  runtime,
  turn,
  white,
} from "./ai-helpers.js";
import {
  ApiHarness,
  command,
  createSandbox,
  KNIGHT_CYCLE,
  snapshot,
  submit,
  type TestApi,
  type TestGuest,
  WEB_ORIGIN,
} from "./helpers.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());

const configurations: CreateAiGameRequest[] = [
  creation,
  { mode: "ai_vs_human", humanColor: "white", ai: white },
  { mode: "ai_vs_human", humanColor: "black", ai: white },
];

function read(api: TestApi, guest: TestGuest, gameId: string) {
  return api.app.inject({
    method: "GET",
    url: `/ai/games/${gameId}`,
    headers: { cookie: guest.cookie },
  });
}

async function play(
  api: TestApi,
  guest: TestGuest,
  initial: GameSnapshot,
  configuration: CreateAiGameRequest,
  history: readonly string[],
) {
  let current = initial;
  for (const move of history) {
    const response =
      configuration.mode === "ai_vs_human" && current.turn === configuration.humanColor
        ? await submit(api, guest, command(current, move))
        : await turn(api, guest, aiCommand(current));
    expect(response.statusCode, response.body).toBe(200);
    current = gameSnapshotSchema.parse(response.json());
  }
  return current;
}

describe("AI recovery across API restarts", () => {
  it("rejects an automatic request from the previous API runtime between accepted moves", async () => {
    const provider = mock([{ output: { move: "e2e4" } }, { output: { move: "e7e5" } }]);
    let api = await harness.createApi({ ai: runtime(provider) });
    const guest = await harness.guest(api);
    const initial = await createAi(api, guest);
    const first = await turn(api, guest, aiCommand(initial));
    const previousRuntime = first.headers[aiRuntimeHeader];
    expect(previousRuntime).toEqual(expect.any(String));
    const accepted = gameSnapshotSchema.parse(first.json());
    await harness.close(api);
    api = await harness.createApi({ ai: runtime(provider) });
    const response = await api.app.inject({
      method: "POST",
      url: `/games/${initial.gameId}/ai-turn`,
      headers: { origin: WEB_ORIGIN, cookie: guest.cookie, [aiRuntimeHeader]: previousRuntime },
      payload: { ...aiCommand(accepted), credential },
    });
    expect(response.statusCode).toBe(409);
    expect(response.headers[aiRuntimeHeader]).not.toBe(previousRuntime);
    expect(response.json()).toMatchObject({ code: "GAME_CONFLICT", currentSnapshot: accepted });
    expect(provider.requests).toHaveLength(1);
    expect((await records(api, initial.gameId)).reservations).toHaveLength(1);
    const paused = gameSnapshotSchema.parse(
      (await lifecycle(api, guest, accepted, "pause")).json(),
    );
    const resumed = gameSnapshotSchema.parse(
      (await lifecycle(api, guest, paused, "resume")).json(),
    );
    expect((await turn(api, guest, aiCommand(resumed))).statusCode).toBe(200);
    expect(provider.requests).toHaveLength(2);
  });
  it.each(configurations)(
    "restores $mode $humanColor configuration and repetition history without credentials or automatic work",
    async (configuration) => {
      const history = [...KNIGHT_CYCLE, ...KNIGHT_CYCLE];
      const steps = history
        .filter(
          (_, index) =>
            configuration.mode === "ai_vs_ai" ||
            (index % 2 === 0 ? "white" : "black") !== configuration.humanColor,
        )
        .map((move) => ({ output: { move } }));
      const provider = mock(steps);
      let api = await harness.createApi({ sandboxEnabled: false, ai: runtime(provider) });
      const guest = await harness.guest(api);
      const before = await play(
        api,
        guest,
        await createAi(api, guest, configuration),
        configuration,
        history.slice(0, 4),
      );
      const calls = provider.requests.length;
      await harness.close(api);
      // No discovery catalog or trusted creation metadata survives the restarted API.
      api = await harness.createApi({
        sandboxEnabled: false,
        ai: { providers: [{ adapter: provider }] },
      });
      const response = await read(api, guest, before.gameId);
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(aiGameResponseSchema.parse(response.json())).toEqual({
        snapshot: before,
        configuration,
      });
      const paused = gameSnapshotSchema.parse(
        (await lifecycle(api, guest, before, "pause")).json(),
      );
      expect(paused).toMatchObject({
        state: "paused",
        moves: before.moves,
        fen: before.fen,
        pgn: before.pgn,
      });
      expect((await read(api, guest, before.gameId)).json()).toEqual({
        snapshot: paused,
        configuration,
      });
      expect(provider.requests).toHaveLength(calls);
      expect(
        (await post(api, guest, `/games/${before.gameId}/ai-turn`, aiCommand(paused))).statusCode,
      ).toBe(400);
      expect(provider.requests).toHaveLength(calls);
      const resumed = gameSnapshotSchema.parse(
        (await lifecycle(api, guest, paused, "resume")).json(),
      );
      expect(provider.requests).toHaveLength(calls);
      const finished = await play(api, guest, resumed, configuration, history.slice(4));
      expect(finished).toMatchObject({
        state: "completed",
        result: "1/2-1/2",
        terminationReason: "threefold_repetition",
      });
      expect(finished.moves.map(({ uci }) => uci)).toEqual(history);
      expect(provider.requests[calls]?.context.pgn).toContain("1. Nf3 Nf6 2. Ng1 Ng8");
      const persisted = JSON.stringify(await records(api, before.gameId));
      expect(persisted).not.toContain("test-only-turn-key");
      expect(JSON.stringify(response.json())).not.toMatch(
        /apiKey|guestSessionId|catalogId|executorId/,
      );
    },
  );

  it.each([configurations[0]!, configurations[2]!])(
    "preserves the fifty-move counter in $mode across restart and pause",
    async (configuration) => {
      const provider = mock(
        FIFTY_MOVE_HISTORY.filter(
          (_, index) => configuration.mode === "ai_vs_ai" || index % 2 === 0,
        ).map((move) => ({ output: { move } })),
      );
      let api = await harness.createApi({ ai: runtime(provider) });
      const guest = await harness.guest(api);
      const before = await play(
        api,
        guest,
        await createAi(api, guest, configuration),
        configuration,
        FIFTY_MOVE_HISTORY.slice(0, 99),
      );
      await harness.close(api);
      api = await harness.createApi({ ai: { providers: [{ adapter: provider }] } });
      const restored = aiGameResponseSchema.parse((await read(api, guest, before.gameId)).json());
      const paused = gameSnapshotSchema.parse(
        (await lifecycle(api, guest, restored.snapshot, "pause")).json(),
      );
      expect(paused.fen.split(" ")[4]).toBe("99");
      const resumed = gameSnapshotSchema.parse(
        (await lifecycle(api, guest, paused, "resume")).json(),
      );
      const finished = await play(api, guest, resumed, configuration, FIFTY_MOVE_HISTORY.slice(99));
      expect(finished.terminationReason).toBe("fifty_move_rule");
      expect(finished.moves).toHaveLength(100);
      expect(finished.fen.split(" ")[4]).toBe("100");
    },
    // A full 100-ply API game includes real PostgreSQL reservation and telemetry writes.
    // Allow slower hosts to complete this scenario within a separate, bounded timeout.
    60_000,
  );

  it.each(["active", "paused"] as const)(
    "fences a %s interrupted invocation after restart before allowing an explicit fresh request",
    async (state) => {
      const provider = mock([{ output: { move: "e2e4" } }]);
      let api = await harness.createApi({ ai: runtime(provider) });
      const guest = await harness.guest(api);
      let initial = await createAi(api, guest);
      if (state === "paused") {
        initial = gameSnapshotSchema.parse((await lifecycle(api, guest, initial, "pause")).json());
      }
      const interrupted = aiCommand(initial);
      const owner = await api.repository.write(async (tx) => {
        const executorId = randomUUID();
        const reserved = await tx.reserveAiTurn({
          ...interrupted,
          ownerGuestSessionId: guest.id,
          executorId,
          color: initial.turn,
          leaseMs: 60_000,
        });
        if (reserved.status !== "reserved") throw new Error("Expected fixture reservation");
        const owner: AiReservationOwner = {
          gameId: initial.gameId,
          ownerGuestSessionId: guest.id,
          executorId,
          reservationId: reserved.reservation.id,
        };
        await tx.beginAiInvocation(owner);
        return owner;
      });
      await harness.close(api);
      api = await harness.createApi({ ai: { providers: [{ adapter: provider }] } });
      expect(
        aiGameResponseSchema.parse((await read(api, guest, initial.gameId)).json()).snapshot,
      ).toMatchObject(initial);
      expect((await turn(api, guest, aiCommand(initial))).statusCode).toBe(409);
      expect(provider.requests).toHaveLength(0);
      const recovered = gameSnapshotSchema.parse(
        (await lifecycle(api, guest, initial, "pause")).json(),
      );
      expect(recovered).toMatchObject({
        state: "paused",
        version: initial.version + 1,
        moves: initial.moves,
      });
      await expect(
        api.repository.write((tx) => tx.renewAiTurn(owner, 60_000)),
      ).rejects.toMatchObject({ code: "RESERVATION_LOST" });
      expect((await records(api, initial.gameId)).invocations[0]?.status).toBe("abandoned");
      expect(
        (await turn(api, guest, { ...interrupted, expectedVersion: recovered.version })).statusCode,
      ).toBe(409);
      expect(provider.requests).toHaveLength(0);
      const accepted = gameSnapshotSchema.parse(
        (await turn(api, guest, aiCommand(recovered))).json(),
      );
      expect(accepted.state).toBe("paused");
      expect(accepted.moves.map(({ uci }) => uci)).toEqual(["e2e4"]);
      expect(provider.requests).toHaveLength(1);
    },
  );

  it("fences delayed unreserved requests with a paused Pause and keeps configuration private", async () => {
    const provider = mock([]);
    const api = await harness.createApi({ ai: runtime(provider) });
    const guest = await harness.guest(api);
    const intruder = await harness.guest(api);
    const initial = await createAi(api, guest);
    const paused = gameSnapshotSchema.parse((await lifecycle(api, guest, initial, "pause")).json());
    const delayed = aiCommand(paused);
    const fenced = gameSnapshotSchema.parse((await lifecycle(api, guest, paused, "pause")).json());
    expect(fenced).toEqual({ ...paused, version: paused.version + 1 });
    expect((await turn(api, guest, delayed)).statusCode).toBe(409);
    expect(provider.requests).toHaveLength(0);
    expect(await snapshot(api, guest, initial.gameId)).toEqual(fenced);
    const denied = await read(api, intruder, initial.gameId);
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).not.toHaveProperty("configuration");
    expect(
      (await api.app.inject({ method: "GET", url: `/ai/games/${initial.gameId}` })).statusCode,
    ).toBe(401);
    const sandbox = await createSandbox(api, intruder);
    expect((await read(api, intruder, sandbox.gameId)).statusCode).toBe(404);
  });
});
