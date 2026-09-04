import {
  isGameLifecycle,
  isRecord,
  type LifecycleEvent,
  transitionLifecycle,
} from "./lifecycle.js";
import { failure, success } from "./result.js";
import { ChessRules } from "./rules.js";
import type {
  ChessColor,
  ChessGame,
  ChessSnapshot,
  DomainResult,
  GameLifecycle,
  MoveRecord,
  RestoreGameInput,
} from "./types.js";

export function createGame(): ChessGame {
  return createGameWithRules(new ChessRules());
}

/** Internal composition seam used by package-local position fixtures. */
export function createGameWithRules(rules: ChessRules): ChessGame {
  return createAggregate(rules).game;
}

function createAggregate(rules: ChessRules) {
  let lifecycle: GameLifecycle = { state: "configuring", result: "*", terminationReason: null };
  const moves: MoveRecord[] = [];

  function snapshot(): ChessSnapshot {
    return {
      ...lifecycle,
      fen: rules.fen(),
      pgn: rules.pgn(lifecycle.result),
      turn: rules.turn(),
      inCheck: rules.inCheck(),
      legalMoves: lifecycle.state === "active" ? rules.legalMoves() : [],
      moves: moves.map((move) => ({ ...move })),
    };
  }

  function transition(event: LifecycleEvent): DomainResult<GameLifecycle> {
    const next = transitionLifecycle(lifecycle, event);
    if (!next.ok) {
      return next;
    }
    lifecycle = next.value;
    if (lifecycle.state === "active") {
      const outcome = rules.outcome();
      if (outcome !== null) {
        lifecycle = { state: "completed", ...outcome };
      }
    }
    return success(lifecycle);
  }

  function withSnapshot(result: DomainResult<GameLifecycle>): DomainResult<ChessSnapshot> {
    return result.ok ? success(snapshot()) : result;
  }

  function completeLoss(
    losingColor: ChessColor,
    terminationReason: "human_resignation" | "model_technical_loss",
  ): DomainResult<GameLifecycle> {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Untyped callers may pass any string; the failure code is part of the domain contract.
    if (losingColor !== "white" && losingColor !== "black") {
      return failure("INVALID_COLOR");
    }
    return transition({
      type: "complete",
      outcome: { result: losingColor === "white" ? "0-1" : "1-0", terminationReason },
    });
  }

  function playMove(uci: string): DomainResult<GameLifecycle> {
    if (lifecycle.state !== "active") {
      return failure("INVALID_GAME_STATE");
    }
    const accepted = rules.playMove(uci, moves.length + 1);
    if (!accepted.ok) {
      return accepted;
    }
    moves.push(accepted.value);
    const outcome = rules.outcome();
    return outcome === null ? success(lifecycle) : transition({ type: "complete", outcome });
  }

  const game: ChessGame = Object.freeze({
    snapshot,
    start: () => withSnapshot(transition({ type: "start" })),
    pause: () => withSnapshot(transition({ type: "pause" })),
    resume: () => withSnapshot(transition({ type: "resume" })),
    abort: () => withSnapshot(transition({ type: "abort" })),
    resignHuman: (losingColor: ChessColor) =>
      withSnapshot(completeLoss(losingColor, "human_resignation")),
    recordTechnicalLoss: (losingColor: ChessColor) =>
      withSnapshot(completeLoss(losingColor, "model_technical_loss")),
    playMove: (uci: string) => withSnapshot(playMove(uci)),
  });

  // Restoration shares live command validation/adjudication without projecting
  // PGN, legal moves, or copied history for every intermediate position.
  return { game, transition, playMove, completeLoss, getLifecycle: () => lifecycle };
}

export function restoreGame(input: RestoreGameInput): DomainResult<ChessGame> {
  if (
    !isRecord(input) ||
    !Array.isArray(input.moves) ||
    Object.keys(input).length !== 2 ||
    !Object.hasOwn(input, "moves") ||
    !Object.hasOwn(input, "lifecycle")
  ) {
    return failure("INVALID_HISTORY");
  }
  if (!isGameLifecycle(input.lifecycle)) {
    return failure("INVALID_LIFECYCLE");
  }
  const { lifecycle } = input;
  const aggregate = createAggregate(new ChessRules());
  const { game } = aggregate;
  if (lifecycle.state === "configuring") {
    return input.moves.length === 0 ? success(game) : failure("INVALID_LIFECYCLE");
  }

  aggregate.transition({ type: "start" });
  const moves: readonly unknown[] = input.moves;
  for (const [index, uci] of moves.entries()) {
    if (typeof uci !== "string" || !aggregate.playMove(uci).ok) {
      return failure("INVALID_HISTORY", index + 1);
    }
  }
  const replayed = aggregate.getLifecycle();
  if (replayed.state === "completed") {
    return lifecycle.state === "completed" &&
      lifecycle.result === replayed.result &&
      lifecycle.terminationReason === replayed.terminationReason
      ? success(game)
      : failure("INVALID_LIFECYCLE");
  }

  switch (lifecycle.state) {
    case "active":
      break;
    case "paused":
      aggregate.transition({ type: "pause" });
      break;
    case "aborted":
      aggregate.transition({ type: "abort" });
      break;
    case "completed": {
      const loser = lifecycle.result === "1-0" ? "black" : "white";
      if (lifecycle.terminationReason === "human_resignation") {
        aggregate.completeLoss(loser, "human_resignation");
      } else if (lifecycle.terminationReason === "model_technical_loss") {
        aggregate.completeLoss(loser, "model_technical_loss");
      } else {
        return failure("INVALID_LIFECYCLE");
      }
      break;
    }
  }
  return success(game);
}
