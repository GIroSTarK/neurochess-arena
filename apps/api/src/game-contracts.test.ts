import * as domain from "@neurochess/chess";
import * as contracts from "@neurochess/contracts";
import { games, gameParticipants, type StoredGame } from "@neurochess/database";
import { describe, expect, expectTypeOf, it } from "vitest";

// Compatibility belongs at a consumer, never in either independent leaf package.
function toTransport(snapshot: domain.ChessSnapshot): contracts.GameSnapshot {
  return {
    ...snapshot,
    gameId: "10000000-0000-4000-8000-000000000001",
    version: 42,
    moves: snapshot.moves.map((move) => ({ ...move })),
    legalMoves: [...snapshot.legalMoves],
  };
}

function unwrap<T>(result: domain.DomainResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe("chess/transport compatibility", () => {
  it("keeps independently owned literals and types aligned", () => {
    expect(domain.CHESS_COLORS).toEqual(contracts.chessColorSchema.options);
    expect(domain.GAME_STATES).toEqual(contracts.gameStateSchema.options);
    expect(domain.GAME_RESULTS).toEqual(contracts.gameResultSchema.options);
    expect(domain.DRAW_REASONS).toEqual(contracts.drawReasonSchema.options);
    expect(domain.WIN_REASONS).toEqual(contracts.winReasonSchema.options);
    expect(domain.TERMINATION_REASONS).toEqual(contracts.terminationReasonSchema.options);
    expectTypeOf<domain.ChessColor>().toEqualTypeOf<contracts.ChessColor>();
    expectTypeOf<domain.GameState>().toEqualTypeOf<contracts.GameState>();
    expectTypeOf<domain.GameResult>().toEqualTypeOf<contracts.GameResult>();
    expectTypeOf<domain.TerminationReason>().toEqualTypeOf<contracts.TerminationReason>();
    expectTypeOf<domain.GameLifecycle>().toExtend<Readonly<contracts.GameLifecycle>>();
    expectTypeOf<Readonly<contracts.GameLifecycle>>().toExtend<domain.GameLifecycle>();
    expectTypeOf<domain.MoveRecord>().toEqualTypeOf<Readonly<contracts.MoveRecord>>();
    expect(games.state.enumValues).toEqual(domain.GAME_STATES);
    expect(games.result.enumValues).toEqual(domain.GAME_RESULTS);
    expect(games.terminationReason.enumValues).toEqual(domain.TERMINATION_REASONS);
    expect(gameParticipants.color.enumValues).toEqual(domain.CHESS_COLORS);
    expectTypeOf<StoredGame["state"]>().toEqualTypeOf<contracts.GameState>();
    expectTypeOf<StoredGame["result"]>().toEqualTypeOf<contracts.GameResult>();
    expectTypeOf<
      NonNullable<StoredGame["terminationReason"]>
    >().toEqualTypeOf<contracts.TerminationReason>();
  });

  it("validates every lifecycle snapshot without importing either leaf into the other", () => {
    const game = domain.createGame();
    const snapshots = [
      game.snapshot(),
      unwrap(game.start()),
      unwrap(game.playMove("e2e4")),
      unwrap(game.pause()),
      unwrap(game.resume()),
      unwrap(game.abort()),
    ];
    for (const ending of ["resignHuman", "recordTechnicalLoss"] as const) {
      for (const color of domain.CHESS_COLORS) {
        const other = domain.createGame();
        unwrap(other.start());
        snapshots.push(unwrap(other[ending](color)));
      }
    }
    for (const moves of [
      ["f2f3", "e7e5", "g2g4", "d8h4"],
      ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"],
    ]) {
      const other = domain.createGame();
      unwrap(other.start());
      for (const move of moves) snapshots.push(unwrap(other.playMove(move)));
    }
    expect([...new Set(snapshots.map((snapshot) => snapshot.state))].sort()).toEqual(
      [...domain.GAME_STATES].sort(),
    );
    for (const snapshot of snapshots) {
      const transport = toTransport(snapshot);
      expect(contracts.gameSnapshotSchema.parse(JSON.parse(JSON.stringify(transport)))).toEqual(
        transport,
      );
      expect(
        contracts.gameLifecycleSchema.parse({
          state: snapshot.state,
          result: snapshot.result,
          terminationReason: snapshot.terminationReason,
        }),
      ).toMatchObject({ state: snapshot.state });
    }
  });

  it("validates wire syntax but leaves actual move legality to the domain", () => {
    const game = domain.createGame();
    unwrap(game.start());
    const command = contracts.moveCommandSchema.parse({
      gameId: "10000000-0000-4000-8000-000000000001",
      commandId: "20000000-0000-4000-8000-000000000002",
      expectedVersion: 42,
      move: "e2e4q",
    });
    expect(game.playMove(command.move)).toEqual({ ok: false, error: { code: "ILLEGAL_MOVE" } });
  });
});
