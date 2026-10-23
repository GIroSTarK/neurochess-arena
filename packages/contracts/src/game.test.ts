import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createGameRequestSchema,
  drawReasonSchema,
  gameCommandIdentitySchema,
  gameErrorCodeSchema,
  gameErrorResponseSchema,
  gameLifecycleSchema,
  gamePgnResponseSchema,
  gameReplayResponseSchema,
  gameSnapshotSchema,
  gameVersionSchema,
  lifecycleCommandSchema,
  moveCommandSchema,
  safeErrorResponseSchema,
  uciMoveSchema,
  unfinishedGameResponseSchema,
  winReasonSchema,
} from "./index.js";

const gameId = "10000000-0000-4000-8000-000000000001";
const commandId = "20000000-0000-4000-8000-000000000002";
const initialSnapshot = {
  gameId,
  version: 0,
  state: "active",
  result: "*",
  terminationReason: null,
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  pgn: '[Result "*"]\n\n*',
  turn: "white",
  inCheck: false,
  legalMoves: ["e2e4", "g1f3"],
  moves: [],
};
const command = { gameId, commandId, move: "e2e4", expectedVersion: 0 };
const moveRecord = {
  ply: 1,
  uci: "e2e4",
  san: "e4",
  fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
};
const errorEnvelope = { message: "application-supplied text", requestId: "request-1" };

describe("game command identity contract", () => {
  const identity = { gameId, commandId, expectedVersion: 0 };

  it("preserves identifiers and aggregate revisions without command-specific fields", () => {
    for (const expectedVersion of [0, Number.MAX_SAFE_INTEGER]) {
      const input = { ...identity, expectedVersion };
      expect(gameCommandIdentitySchema.parse(input)).toEqual(input);
    }
  });

  it("rejects missing or malformed identity fields and extra command or authority fields", () => {
    for (const input of [
      {},
      { gameId, commandId },
      { gameId, expectedVersion: 0 },
      { commandId, expectedVersion: 0 },
      { ...identity, gameId: "invalid" },
      { ...identity, commandId: "invalid" },
      ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0", null].map((expectedVersion) => ({
        ...identity,
        expectedVersion,
      })),
      ...["move", "action", "controllerId", "ownerId", "apiKey"].map((field) => ({
        ...identity,
        [field]: "untrusted",
      })),
    ]) {
      expect(gameCommandIdentitySchema.safeParse(input).success).toBe(false);
    }
  });
});

describe("lifecycle and private read contracts", () => {
  it("requires an explicit human color only for resignation and rejects extra authority", () => {
    const base = { gameId, commandId, expectedVersion: 4 };
    for (const action of ["pause", "resume", "abort"]) {
      expect(lifecycleCommandSchema.parse({ ...base, action })).toEqual({ ...base, action });
      expect(
        lifecycleCommandSchema.safeParse({ ...base, action, losingColor: "white" }).success,
      ).toBe(false);
    }
    for (const losingColor of ["white", "black"]) {
      expect(
        lifecycleCommandSchema.safeParse({ ...base, action: "resign", losingColor }).success,
      ).toBe(true);
    }
    for (const invalid of [
      { action: "resign" },
      { action: "resign", losingColor: "ai" },
      { action: "pause", ownerId: gameId },
      { action: "technical_loss" },
      { action: "pause", expectedVersion: -1 },
      { action: "pause", commandId: "invalid" },
    ]) {
      expect(lifecycleCommandSchema.safeParse({ ...base, ...invalid }).success).toBe(false);
    }
  });
  it("separates unfinished discovery from terminal replay and bounds export shapes", () => {
    const terminal = {
      ...initialSnapshot,
      state: "aborted",
      terminationReason: "aborted",
      legalMoves: [],
    };
    expect(unfinishedGameResponseSchema.safeParse({ snapshot: initialSnapshot }).success).toBe(
      true,
    );
    expect(unfinishedGameResponseSchema.safeParse({ snapshot: null }).success).toBe(true);
    expect(unfinishedGameResponseSchema.safeParse({ snapshot: terminal }).success).toBe(false);
    expect(
      gameReplayResponseSchema.safeParse({
        snapshot: initialSnapshot,
        initialFen: initialSnapshot.fen,
      }).success,
    ).toBe(false);
    expect(
      gameReplayResponseSchema.safeParse({ snapshot: terminal, initialFen: initialSnapshot.fen })
        .success,
    ).toBe(true);
    expect(gamePgnResponseSchema.safeParse({ gameId, version: 1, pgn: terminal.pgn }).success).toBe(
      true,
    );
    expect(
      gamePgnResponseSchema.safeParse({ gameId, version: 1, pgn: terminal.pgn, token: "canary" })
        .success,
    ).toBe(false);
  });
});

describe("standard game creation contract", () => {
  it("accepts only an empty request object", () => {
    expect(createGameRequestSchema.parse({})).toEqual({});
    for (const input of [undefined, null, [], "", 0]) {
      expect(createGameRequestSchema.safeParse(input).success).toBe(false);
    }
  });

  it.each([
    "fen",
    "moves",
    "ownerId",
    "guestId",
    "sandbox",
    "mode",
    "provider",
    "apiKey",
    "result",
  ])("does not accept client-supplied %s", (key) =>
    expect(createGameRequestSchema.safeParse({ [key]: "untrusted" }).success).toBe(false),
  );
});

describe("move command contracts", () => {
  it("retains the game, command identifier and expected version unchanged", () => {
    expect(moveCommandSchema.parse(command)).toEqual(command);
    expect(moveCommandSchema.parse(command)).toEqual(moveCommandSchema.parse(command));
  });

  it.each(["e2e4", "e7e8q", "a2a1n", "a7b8b", "h2g1r", "e1g1", "e2e5", "e2e4q"])(
    "accepts UCI syntax without attempting board legality: %s",
    (move) => expect(uciMoveSchema.parse(move)).toBe(move),
  );

  it.each([
    { name: "empty string", move: "" },
    { name: "SAN pawn move", move: "e4" },
    { name: "SAN castling", move: "O-O" },
    { name: "null-move digits", move: "0000" },
    { name: "null-move dashes", move: "--" },
    { name: "rank outside board", move: "a0a1" },
    { name: "file outside board", move: "i1a1" },
    { name: "same square", move: "e2e2" },
    { name: "uppercase squares", move: "E2E4" },
    { name: "uppercase promotion", move: "a7a8Q" },
    { name: "king promotion", move: "a7a8k" },
    { name: "leading space", move: " e2e4" },
    { name: "trailing space", move: "e2e4 " },
    { name: "trailing LF", move: "e2e4\n" },
    { name: "trailing CRLF", move: "e2e4\r\n" },
    { name: "promotion with trailing LF", move: "e2e4q\n" },
    { name: "null", move: null },
    { name: "number", move: 12 },
  ])("rejects noncanonical UCI syntax: $name", ({ move }) =>
    expect(uciMoveSchema.safeParse(move).success).toBe(false),
  );

  it.each(["gameId", "commandId", "move", "expectedVersion"])("requires %s", (key) => {
    const input: Record<string, unknown> = { ...command };
    delete input[key];
    expect(moveCommandSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    { name: "empty string", id: "" },
    { name: "malformed UUID", id: "not-a-uuid" },
    { name: "UUID with newline", id: "10000000-0000-4000-8000-000000000001\n" },
    { name: "null", id: null },
    { name: "number", id: 1 },
  ])("requires UUID identifiers: $name", ({ id }) => {
    expect(moveCommandSchema.safeParse({ ...command, gameId: id }).success).toBe(false);
    expect(moveCommandSchema.safeParse({ ...command, commandId: id }).success).toBe(false);
  });

  it.each([
    { name: "negative version", version: -1 },
    { name: "fractional version", version: 0.5 },
    { name: "unsafe integer version", version: Number.MAX_SAFE_INTEGER + 1 },
    { name: "NaN version", version: NaN },
    { name: "Infinity version", version: Infinity },
    { name: "string version", version: "1" },
    { name: "null version", version: null },
    { name: "undefined version", version: undefined },
  ])("rejects invalid version: $name", ({ version }) => {
    expect(gameVersionSchema.safeParse(version).success).toBe(false);
    expect(moveCommandSchema.safeParse({ ...command, expectedVersion: version }).success).toBe(
      false,
    );
    expect(gameSnapshotSchema.safeParse({ ...initialSnapshot, version }).success).toBe(false);
  });

  it.each([0, 1, Number.MAX_SAFE_INTEGER])("accepts nonnegative safe version %s", (version) => {
    expect(gameVersionSchema.parse(version)).toBe(version);
  });

  it.each(["fen", "color", "promotion", "userId", "apiKey"])(
    "rejects unrecognized command field %s",
    (key) => {
      expect(moveCommandSchema.safeParse({ ...command, [key]: "untrusted" }).success).toBe(false);
    },
  );
});

describe("lifecycle contracts", () => {
  it.each(["configuring", "active", "paused"])("accepts an unfinished %s lifecycle", (state) => {
    expect(gameLifecycleSchema.parse({ state, result: "*", terminationReason: null })).toEqual({
      state,
      result: "*",
      terminationReason: null,
    });
  });

  it("accepts every supported completed outcome and abortion", () => {
    for (const terminationReason of winReasonSchema.options) {
      for (const result of ["1-0", "0-1"]) {
        expect(
          gameLifecycleSchema.safeParse({ state: "completed", result, terminationReason }).success,
        ).toBe(true);
      }
    }
    for (const terminationReason of drawReasonSchema.options) {
      expect(
        gameLifecycleSchema.safeParse({ state: "completed", result: "1/2-1/2", terminationReason })
          .success,
      ).toBe(true);
    }
    expect(
      gameLifecycleSchema.safeParse({ state: "aborted", result: "*", terminationReason: "aborted" })
        .success,
    ).toBe(true);
  });

  it.each([
    {
      name: "unknown state",
      lifecycle: { state: "unknown", result: "*", terminationReason: null },
    },
    {
      name: "active game with result",
      lifecycle: { state: "active", result: "1-0", terminationReason: "checkmate" },
    },
    {
      name: "paused game with termination",
      lifecycle: { state: "paused", result: "*", terminationReason: "provider_timeout" },
    },
    {
      name: "completed game without result",
      lifecycle: { state: "completed", result: "*", terminationReason: null },
    },
    {
      name: "draw by checkmate",
      lifecycle: { state: "completed", result: "1/2-1/2", terminationReason: "checkmate" },
    },
    {
      name: "decisive stalemate",
      lifecycle: { state: "completed", result: "0-1", terminationReason: "stalemate" },
    },
    {
      name: "draw by technical loss",
      lifecycle: {
        state: "completed",
        result: "1/2-1/2",
        terminationReason: "model_technical_loss",
      },
    },
    {
      name: "completed game marked aborted",
      lifecycle: { state: "completed", result: "1-0", terminationReason: "aborted" },
    },
    {
      name: "aborted game with winner",
      lifecycle: { state: "aborted", result: "0-1", terminationReason: "aborted" },
    },
    {
      name: "aborted game without reason",
      lifecycle: { state: "aborted", result: "*", terminationReason: null },
    },
    {
      name: "extra winner field",
      lifecycle: { state: "active", result: "*", terminationReason: null, winner: "white" },
    },
  ])("rejects inconsistent lifecycle: $name", ({ lifecycle }) => {
    expect(gameLifecycleSchema.safeParse(lifecycle).success).toBe(false);
    expect(
      gameSnapshotSchema.safeParse({ ...initialSnapshot, legalMoves: [], ...lifecycle }).success,
    ).toBe(false);
  });
});

describe("snapshot contracts", () => {
  it("accepts a snapshot without treating version as a ply count", () => {
    expect(gameSnapshotSchema.parse(initialSnapshot)).toEqual(initialSnapshot);
    expect(gameSnapshotSchema.safeParse({ ...initialSnapshot, version: 99 }).success).toBe(true);
  });

  it.each(Object.keys(initialSnapshot))("requires snapshot field %s", (key) => {
    const input: Record<string, unknown> = { ...initialSnapshot };
    delete input[key];
    expect(gameSnapshotSchema.safeParse(input).success).toBe(false);
  });

  it("rejects unknown fields at the snapshot and move-record boundaries", () => {
    expect(gameSnapshotSchema.safeParse({ ...initialSnapshot, apiKey: "canary" }).success).toBe(
      false,
    );
    expect(
      gameSnapshotSchema.safeParse({
        ...initialSnapshot,
        moves: [{ ...moveRecord, apiKey: "canary" }],
      }).success,
    ).toBe(false);
  });

  it.each([
    { name: "empty FEN", fields: { fen: "" } },
    { name: "empty PGN", fields: { pgn: "" } },
    { name: "invalid turn", fields: { turn: "w" } },
    { name: "non-boolean check flag", fields: { inCheck: "false" } },
    { name: "SAN in legal moves", fields: { legalMoves: ["Nf3"] } },
    { name: "empty move SAN", fields: { moves: [{ ...moveRecord, san: "" }] } },
    { name: "empty move FEN", fields: { moves: [{ ...moveRecord, fen: "" }] } },
    { name: "non-UCI move", fields: { moves: [{ ...moveRecord, uci: "e4" }] } },
    { name: "zero ply", fields: { moves: [{ ...moveRecord, ply: 0 }] } },
    { name: "fractional ply", fields: { moves: [{ ...moveRecord, ply: 1.5 }] } },
    { name: "nonsequential first ply", fields: { moves: [{ ...moveRecord, ply: 2 }] } },
    { name: "duplicate ply", fields: { moves: [moveRecord, moveRecord] } },
  ])("rejects invalid snapshot: $name", ({ fields }) => {
    expect(gameSnapshotSchema.safeParse({ ...initialSnapshot, ...fields }).success).toBe(false);
  });

  it("requires non-active snapshots to expose no playable moves", () => {
    for (const lifecycle of [
      { state: "paused", result: "*", terminationReason: null },
      { state: "configuring", result: "*", terminationReason: null },
      { state: "aborted", result: "*", terminationReason: "aborted" },
      { state: "completed", result: "1-0", terminationReason: "checkmate" },
    ]) {
      expect(gameSnapshotSchema.safeParse({ ...initialSnapshot, ...lifecycle }).success).toBe(
        false,
      );
      expect(
        gameSnapshotSchema.safeParse({ ...initialSnapshot, ...lifecycle, legalMoves: [] }).success,
      ).toBe(true);
    }
  });

  it("rejects accepted moves in a configuring game", () => {
    expect(
      gameSnapshotSchema.safeParse({
        ...initialSnapshot,
        state: "configuring",
        legalMoves: [],
        moves: [moveRecord],
      }).success,
    ).toBe(false);
  });

  it("can be represented as JSON Schema for future route integration", () => {
    for (const schema of [
      createGameRequestSchema,
      moveCommandSchema,
      gameSnapshotSchema,
      gameErrorResponseSchema,
    ]) {
      expect(z.toJSONSchema(schema)).toHaveProperty("$schema");
    }
  });
});

describe("structured game errors", () => {
  it("preserves the system error envelope and narrows game error codes", () => {
    for (const code of gameErrorCodeSchema.options.filter((code) => code !== "GAME_CONFLICT")) {
      const error = { code, ...errorEnvelope };
      expect(gameErrorResponseSchema.parse(error)).toEqual(error);
      expect(safeErrorResponseSchema.parse(error)).toEqual(error);
    }
    expect(
      safeErrorResponseSchema.safeParse({ ...errorEnvelope, code: "CUSTOM_SYSTEM_CODE" }).success,
    ).toBe(true);
    expect(
      gameErrorResponseSchema.safeParse({ ...errorEnvelope, code: "CUSTOM_SYSTEM_CODE" }).success,
    ).toBe(false);
  });

  it("requires the current snapshot for conflicts, but forbids it on other errors", () => {
    expect(
      gameErrorResponseSchema.safeParse({ ...errorEnvelope, code: "GAME_CONFLICT" }).success,
    ).toBe(false);
    expect(
      gameErrorResponseSchema.parse({
        ...errorEnvelope,
        code: "GAME_CONFLICT",
        currentSnapshot: initialSnapshot,
      }),
    ).toHaveProperty("currentSnapshot", initialSnapshot);
    expect(
      gameErrorResponseSchema.safeParse({
        ...errorEnvelope,
        code: "FORBIDDEN",
        currentSnapshot: initialSnapshot,
      }).success,
    ).toBe(false);
  });

  it.each(["stack", "cause", "details", "apiKey", "authorization", "rawResponse"])(
    "refuses raw or unbounded error field %s",
    (key) => {
      expect(
        gameErrorResponseSchema.safeParse({
          ...errorEnvelope,
          code: "ILLEGAL_MOVE",
          [key]: "canary",
        }).success,
      ).toBe(false);
      expect(
        gameErrorResponseSchema.safeParse({
          ...errorEnvelope,
          code: "GAME_CONFLICT",
          currentSnapshot: initialSnapshot,
          [key]: "canary",
        }).success,
      ).toBe(false);
    },
  );

  it("requires a safe envelope on every error", () => {
    expect(
      gameErrorResponseSchema.safeParse({ code: "ILLEGAL_MOVE", message: "text" }).success,
    ).toBe(false);
    expect(
      gameErrorResponseSchema.safeParse({ code: "ILLEGAL_MOVE", ...errorEnvelope, message: "" })
        .success,
    ).toBe(false);
  });
});
