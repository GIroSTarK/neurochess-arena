import { randomUUID } from "node:crypto";

import { createGame } from "@neurochess/chess";
import {
  gamePgnResponseSchema,
  gameReplayResponseSchema,
  type GameSnapshot,
  gameSnapshotSchema,
  type LifecycleCommand,
  unfinishedGameResponseSchema,
} from "@neurochess/contracts";
import { gameCommands, gameParticipants, games, guestSessions, moves } from "@neurochess/database";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import {
  ApiHarness,
  command,
  createSandbox,
  FOOLS_MATE,
  KNIGHT_CYCLE,
  play,
  snapshot,
  submit,
  type TestApi,
  type TestGuest,
  WEB_ORIGIN,
} from "./helpers.js";

const harness = new ApiHarness();
afterEach(() => harness.dispose());
type Action =
  { action: "pause" | "resume" | "abort" } | { action: "resign"; losingColor: "white" | "black" };
function control(current: GameSnapshot, action: Action): LifecycleCommand {
  return {
    ...action,
    gameId: current.gameId,
    expectedVersion: current.version,
    commandId: randomUUID(),
  };
}
function send(api: TestApi, guest: TestGuest, body: LifecycleCommand) {
  return api.app.inject({
    method: "POST",
    url: "/games/" + body.gameId + "/lifecycle",
    headers: { cookie: guest.cookie, origin: WEB_ORIGIN },
    payload: body,
  });
}
async function apply(api: TestApi, guest: TestGuest, current: GameSnapshot, action: Action) {
  const response = await send(api, guest, control(current, action));
  expect(response.statusCode, response.body).toBe(200);
  return gameSnapshotSchema.parse(response.json());
}
function get(api: TestApi, guest: TestGuest, path: string) {
  return api.app.inject({ method: "GET", url: path, headers: { cookie: guest.cookie } });
}

describe("persisted lifecycle controls", () => {
  it("recovers through a new API/pool at half-move 99 and draws on half-move 100", async () => {
    // Recorded quiet legal play from the standard start; no earlier third occurrence.
    const history = [
      "b1a3 g8f6 a3b1 f6g4 b1a3 b8a6 a3b5 g4e5 b5d4 e5g4",
      "d4e6 a6c5 e6d4 c5a6 d4f3 a6b4 f3d4 b4d5 d4f5 g4f6",
      "f5h6 f6g4 g1f3 g4e3 a1b1 d5f6 f3e5 e3d5 h1g1 f6h5",
      "b1a1 h5f4 h6g8 d5b6 e5f3 a8b8 f3e5 f4d5 e5g6 d5f6",
      "a1b1 b6d5 b1a1 f6e4 g6f4 d5e3 f4g6 e4f6 g6f4 b8a8",
      "f4d3 a8b8 a1b1 f6g4 g1h1 g4f6 d3f4 b8a8 f4d5 e3g4",
      "g8h6 f6h5 h1g1 h8g8 d5c3 h5g3 c3d5 g8h8 d5f4 g4e3",
      "h6g8 e3g4 f4h5 g4h6 g1h1 a8b8 b1a1 g3f5 a1b1 f5e3",
      "h5g3 e3g4 b1a1 b8a8 a1b1 g4e5 g3f5 e5g6 b1a1 a8b8",
      "f5h4 g6e5 h4f5 e5g6 f5h4 h6g4 h4f5 g4e3 g8h6 e3c4",
    ]
      .join(" ")
      .split(" ");
    let api = await harness.createApi();
    const guest = await harness.guest(api);
    const before = await play(api, guest, await createSandbox(api, guest), history.slice(0, 99));
    await harness.close(api);
    api = await harness.createApi();
    const recovered = unfinishedGameResponseSchema.parse(
      (await get(api, guest, "/sandbox/games/unfinished")).json(),
    ).snapshot!;
    expect(recovered).toEqual(before);
    const paused = await apply(api, guest, recovered, { action: "pause" });
    expect(paused.fen.split(" ")[4]).toBe("99");
    expect(paused.moves).toEqual(before.moves);
    const resumed = await apply(api, guest, paused, { action: "resume" });
    const finished = await play(api, guest, resumed, history.slice(99));
    expect(finished).toMatchObject({
      state: "completed",
      result: "1/2-1/2",
      terminationReason: "fifty_move_rule",
    });
    expect(finished.moves).toHaveLength(100);
    expect(finished.fen.split(" ")[4]).toBe("100");
    expect((await get(api, guest, "/games/" + finished.gameId + "/pgn")).json()).toHaveProperty(
      "pgn",
      finished.pgn,
    );
  });

  it("pauses and resumes without changing history or releasing the unfinished slot", async () => {
    const api = await harness.createApi();
    const guest = await harness.guest(api);
    const active = await play(api, guest, await createSandbox(api, guest), KNIGHT_CYCLE);
    const paused = await apply(api, guest, active, { action: "pause" });
    expect(paused).toEqual({
      ...active,
      version: active.version + 1,
      state: "paused",
      legalMoves: [],
    });
    const occupied = await api.app.inject({
      method: "POST",
      url: "/sandbox/games",
      payload: {},
      headers: { cookie: guest.cookie, origin: WEB_ORIGIN },
    });
    expect(occupied.json()).toHaveProperty("currentSnapshot", paused);
    expect((await send(api, guest, control(paused, { action: "pause" }))).json()).toHaveProperty(
      "code",
      "INVALID_GAME_STATE",
    );
    expect((await submit(api, guest, command(paused, "g1f3"))).json()).toHaveProperty(
      "code",
      "INVALID_GAME_STATE",
    );
    const resumed = await apply(api, guest, paused, { action: "resume" });
    expect(resumed).toEqual({ ...active, version: active.version + 2 });
    expect((await send(api, guest, control(resumed, { action: "resume" }))).json()).toHaveProperty(
      "code",
      "INVALID_GAME_STATE",
    );
    const finished = await play(api, guest, resumed, KNIGHT_CYCLE);
    expect(finished).toMatchObject({
      state: "completed",
      terminationReason: "threefold_repetition",
      version: 10,
    });
    expect(finished.moves).toHaveLength(8);
  });

  it.each(["white", "black"] as const)(
    "resigns the human %s seat off-turn while paused and retains the result",
    async (losingColor) => {
      const api = await harness.createApi();
      const guest = await harness.guest(api);
      let current = await createSandbox(api, guest);
      if (losingColor === "white") current = await play(api, guest, current, ["e2e4"]);
      current = await apply(api, guest, current, { action: "pause" });
      const resigned = await apply(api, guest, current, { action: "resign", losingColor });
      expect(resigned).toMatchObject({
        state: "completed",
        result: losingColor === "white" ? "0-1" : "1-0",
        terminationReason: "human_resignation",
        version: current.version + 1,
      });
      expect(resigned.moves).toEqual(current.moves);
      expect(resigned.fen).toBe(current.fen);
      expect(resigned.pgn).toContain('[Result "' + resigned.result + '"]');
      expect(await snapshot(api, guest, resigned.gameId)).toEqual(resigned);
      expect((await createSandbox(api, guest)).gameId).not.toBe(resigned.gameId);
    },
  );

  it.each([false, true])(
    "aborts with no winner, retains private replay, and releases the slot (paused=%s)",
    async (paused) => {
      const api = await harness.createApi();
      const guest = await harness.guest(api);
      let current = await createSandbox(api, guest);
      if (paused) {
        current = await play(api, guest, current, ["e2e4"]);
        current = await apply(api, guest, current, { action: "pause" });
      }
      const aborted = await apply(api, guest, current, { action: "abort" });
      expect(aborted).toEqual({
        ...current,
        state: "aborted",
        terminationReason: "aborted",
        result: "*",
        version: current.version + 1,
        legalMoves: [],
      });
      expect((await submit(api, guest, command(aborted, "a2a3"))).json()).toHaveProperty(
        "code",
        "INVALID_GAME_STATE",
      );
      for (const action of [
        { action: "pause" },
        { action: "resume" },
        { action: "abort" },
        { action: "resign", losingColor: "white" },
      ] as const) {
        expect((await send(api, guest, control(aborted, action))).json()).toHaveProperty(
          "code",
          "INVALID_GAME_STATE",
        );
      }
      await createSandbox(api, guest);
      expect(
        gameReplayResponseSchema.parse(
          (await get(api, guest, "/games/" + aborted.gameId + "/replay")).json(),
        ).snapshot,
      ).toEqual(aborted);
      expect(
        gamePgnResponseSchema.parse(
          (await get(api, guest, "/games/" + aborted.gameId + "/pgn")).json(),
        ).pgn,
      ).toBe(aborted.pgn);
    },
  );

  it("deduplicates accepted IDs across moves and every lifecycle kind, including uppercase aliases", async () => {
    const api = await harness.createApi();
    const guest = await harness.guest(api);
    const initial = await createSandbox(api, guest);
    const moved = command(initial, "e2e4");
    const current = gameSnapshotSchema.parse((await submit(api, guest, moved)).json());
    const reused = {
      ...control(current, { action: "abort" }),
      commandId: moved.commandId.toUpperCase(),
    };
    expect((await send(api, guest, reused)).json()).toHaveProperty("currentSnapshot", current);
    const pause = control(current, { action: "pause" });
    const paused = gameSnapshotSchema.parse((await send(api, guest, pause)).json());
    const resumed = await apply(api, guest, paused, { action: "resume" });
    expect(
      (
        await submit(api, guest, { ...command(resumed, "e7e5"), commandId: pause.commandId })
      ).json(),
    ).toHaveProperty("currentSnapshot", resumed);
    const abort = control(resumed, { action: "abort" });
    const aborted = gameSnapshotSchema.parse((await send(api, guest, abort)).json());
    expect((await send(api, guest, abort)).json()).toHaveProperty("currentSnapshot", aborted);
    expect(
      (
        await send(api, guest, {
          ...control(aborted, { action: "resign", losingColor: "black" }),
          commandId: abort.commandId,
        })
      ).json(),
    ).toHaveProperty("currentSnapshot", aborted);
    expect(
      await api.database.db.$count(gameCommands, eq(gameCommands.gameId, initial.gameId)),
    ).toBe(4);
  });

  it("serializes move/control races across independent pools", async () => {
    const api = await harness.createApi();
    const other = await harness.createApi();
    const guest = await harness.guest(api);
    const initial = await createSandbox(api, guest);
    const responses = await Promise.all([
      submit(api, guest, command(initial, "e2e4")),
      send(other, guest, control(initial, { action: "pause" })),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const current = await snapshot(api, guest, initial.gameId);
    expect(current.version).toBe(1);
    expect(current.moves.length).toBe(current.state === "active" ? 1 : 0);
    expect(
      await api.database.db.$count(gameCommands, eq(gameCommands.gameId, initial.gameId)),
    ).toBe(1);
  });

  it("rolls back lifecycle receipts and state when position persistence fails", async () => {
    const api = await harness.createApi();
    const guest = await harness.guest(api);
    const initial = await createSandbox(api, guest);
    const failing = await harness.createApi({
      repository: (repository) => ({
        ...repository,
        write: (action) =>
          repository.write((tx) =>
            action({
              ...tx,
              updatePosition: async () => {
                throw new Error("failure-canary");
              },
            }),
          ),
      }),
    });
    const pause = control(initial, { action: "pause" });
    const failed = await send(failing, guest, pause);
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain("failure-canary");
    expect(await snapshot(api, guest, initial.gameId)).toEqual(initial);
    expect(
      await api.database.db.$count(gameCommands, eq(gameCommands.gameId, initial.gameId)),
    ).toBe(0);
    expect((await send(api, guest, pause)).statusCode).toBe(200);
  });
});

describe("private discovery, replay and PGN", () => {
  it("discovers only the owner's unfinished sandbox, without changing its lifecycle or creating a guest", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const other = await harness.guest(api);
    expect(
      unfinishedGameResponseSchema.parse(
        (await get(api, owner, "/sandbox/games/unfinished")).json(),
      ).snapshot,
    ).toBeNull();
    const current = await createSandbox(api, owner);
    expect((await get(api, owner, "/sandbox/games/unfinished")).json()).toEqual({
      snapshot: current,
    });
    expect((await get(api, other, "/sandbox/games/unfinished")).json()).toEqual({ snapshot: null });
    expect(await snapshot(api, owner, current.gameId)).toEqual(current);
    for (const endpoint of ["replay", "pgn"]) {
      expect(
        (await get(api, owner, "/games/" + current.gameId + "/" + endpoint)).json(),
      ).toHaveProperty("code", "INVALID_GAME_STATE");
    }
    await apply(api, owner, current, { action: "abort" });
    expect((await get(api, owner, "/sandbox/games/unfinished")).json()).toEqual({ snapshot: null });
  });

  it("rejects foreign, absent, expired and disabled access without disclosing private snapshots or exports", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const intruder = await harness.guest(api);
    const current = await play(api, owner, await createSandbox(api, owner), FOOLS_MATE);
    for (const path of [
      "/games/" + current.gameId,
      "/games/" + current.gameId + "/replay",
      "/games/" + current.gameId + "/pgn",
    ]) {
      const denied = await get(api, intruder, path);
      expect(denied.statusCode).toBe(404);
      expect(denied.json()).not.toHaveProperty("currentSnapshot");
      expect(denied.body).not.toContain(current.fen);
      expect((await api.app.inject({ method: "GET", url: path })).statusCode).toBe(401);
      const disabled = await harness.createApi({ sandboxEnabled: false });
      expect((await get(disabled, owner, path)).statusCode).toBe(404);
    }
    expect((await send(api, intruder, control(current, { action: "abort" }))).statusCode).toBe(404);
    await api.database.db
      .update(guestSessions)
      .set({
        lastSeenAt: sql`clock_timestamp() - interval '2 hours'`,
        expiresAt: sql`clock_timestamp() - interval '1 hour'`,
      })
      .where(eq(guestSessions.id, owner.id));
    for (const suffix of ["replay", "pgn"]) {
      expect((await get(api, owner, "/games/" + current.gameId + "/" + suffix)).statusCode).toBe(
        401,
      );
    }
    expect((await get(api, owner, "/sandbox/games/unfinished")).statusCode).toBe(401);
    expect((await send(api, owner, control(current, { action: "abort" }))).statusCode).toBe(401);
  });

  it("keeps ordinary lifecycle ownership and human-seat authority distinct", async () => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    const opponent = await harness.guest(api);
    const initial = await createSandbox(api, owner);
    await api.database.db
      .update(games)
      .set({ isSandbox: false })
      .where(eq(games.id, initial.gameId));
    await api.database.db
      .update(gameParticipants)
      .set({ guestSessionId: opponent.id })
      .where(and(eq(gameParticipants.gameId, initial.gameId), eq(gameParticipants.color, "black")));
    for (const action of ["pause", "resume", "abort"] as const) {
      expect((await send(api, opponent, control(initial, { action }))).statusCode).toBe(403);
    }
    expect(
      (await send(api, owner, control(initial, { action: "resign", losingColor: "black" })))
        .statusCode,
    ).toBe(403);
    expect((await get(api, owner, "/sandbox/games/unfinished")).json()).toEqual({ snapshot: null });
    expect(
      (await apply(api, opponent, initial, { action: "resign", losingColor: "black" })).result,
    ).toBe("1-0");
    const sandbox = await createSandbox(api, owner);
    await api.database.db
      .update(gameParticipants)
      .set({ seatType: "ai" })
      .where(and(eq(gameParticipants.gameId, sandbox.gameId), eq(gameParticipants.color, "black")));
    expect(
      (await send(api, owner, control(sandbox, { action: "resign", losingColor: "black" })))
        .statusCode,
    ).toBe(403);
  });

  it.each([
    { name: "checkmate", history: FOOLS_MATE },
    { name: "repetition", history: [...KNIGHT_CYCLE, ...KNIGHT_CYCLE] },
    { name: "castling", history: ["e2e4", "e7e5", "g1f3", "b8c6", "f1e2", "g8f6", "e1g1"] },
    { name: "en passant", history: ["e2e4", "a7a6", "e4e5", "d7d5", "e5d6"] },
    {
      name: "promotion",
      history: ["a2a4", "h7h5", "a4a5", "h5h4", "a5a6", "h4h3", "a6b7", "h3g2", "b7a8n", "g2h1r"],
    },
  ])("replays and exports $name without mutating accepted data", async ({ history }) => {
    const api = await harness.createApi();
    const owner = await harness.guest(api);
    let current = await play(api, owner, await createSandbox(api, owner), history);
    if (current.state === "active") {
      current = await apply(api, owner, current, { action: "resign", losingColor: "black" });
    }
    const before = await api.database.db.select().from(games).where(eq(games.id, current.gameId));
    const storedMoves = await api.database.db
      .select()
      .from(moves)
      .where(eq(moves.gameId, current.gameId))
      .orderBy(moves.ply);
    const replay = await get(api, owner, "/games/" + current.gameId + "/replay");
    const exported = await get(api, owner, "/games/" + current.gameId + "/pgn");
    expect(replay.headers["cache-control"]).toBe("no-store");
    expect(exported.headers["cache-control"]).toBe("no-store");
    const replayed = gameReplayResponseSchema.parse(replay.json());
    expect(replayed.snapshot).toEqual(current);
    expect(replayed.initialFen).toBe(createGame().snapshot().fen);
    expect(replayed.snapshot.moves.map((move) => move.fen)).toEqual(
      storedMoves.map((move) => move.fen),
    );
    expect(gamePgnResponseSchema.parse(exported.json())).toEqual({
      gameId: current.gameId,
      version: current.version,
      pgn: current.pgn,
    });
    expect(await api.database.db.select().from(games).where(eq(games.id, current.gameId))).toEqual(
      before,
    );
    expect(
      await api.database.db
        .select()
        .from(moves)
        .where(eq(moves.gameId, current.gameId))
        .orderBy(moves.ply),
    ).toEqual(storedMoves);
    expect(current.pgn.trim().endsWith(current.result)).toBe(true);
  });

  it("validates lifecycle bodies, matching game IDs, queries and Origin before mutation", async () => {
    const api = await harness.createApi();
    const guest = await harness.guest(api);
    const current = await createSandbox(api, guest);
    const body = control(current, { action: "pause" });
    for (const invalid of [
      { ...body, losingColor: "white" },
      { ...body, action: "resign" },
      { ...body, action: "resign", losingColor: "blue" },
      { ...body, action: "technical_loss" },
      { ...body, fen: "untrusted" },
      { ...body, gameId: randomUUID() },
    ]) {
      expect(
        (
          await api.app.inject({
            method: "POST",
            url: "/games/" + current.gameId + "/lifecycle",
            headers: { cookie: guest.cookie, origin: WEB_ORIGIN },
            payload: invalid,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await api.app.inject({
          method: "POST",
          url: "/games/" + current.gameId + "/lifecycle",
          headers: { cookie: guest.cookie },
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    for (const path of [
      "/sandbox/games/unfinished",
      "/games/" + current.gameId + "/replay",
      "/games/" + current.gameId + "/pgn",
    ]) {
      expect((await get(api, guest, path + "?owner=untrusted")).statusCode).toBe(400);
    }
    expect(await snapshot(api, guest, current.gameId)).toEqual(current);
  });
});
