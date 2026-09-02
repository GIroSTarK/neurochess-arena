import {
  isGameLifecycle,
  isRecord,
  transitionLifecycle,
  type LifecycleEvent,
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

  function transition(event: LifecycleEvent): DomainResult<ChessSnapshot> {
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
    return success(snapshot());
  }

  function completeLoss(
    losingColor: ChessColor,
    terminationReason: "human_resignation" | "model_technical_loss",
  ): DomainResult<ChessSnapshot> {
    if (losingColor !== "white" && losingColor !== "black") {
      return failure("INVALID_COLOR");
    }
    return transition({
      type: "complete",
      outcome: { result: losingColor === "white" ? "0-1" : "1-0", terminationReason },
    });
  }

  return Object.freeze({
    snapshot,
    start: () => transition({ type: "start" }),
    pause: () => transition({ type: "pause" }),
    resume: () => transition({ type: "resume" }),
    abort: () => transition({ type: "abort" }),
    resignHuman: (losingColor: ChessColor) => completeLoss(losingColor, "human_resignation"),
    recordTechnicalLoss: (losingColor: ChessColor) =>
      completeLoss(losingColor, "model_technical_loss"),
    playMove(uci: string): DomainResult<ChessSnapshot> {
      if (lifecycle.state !== "active") {
        return failure("INVALID_GAME_STATE");
      }
      const accepted = rules.playMove(uci, moves.length + 1);
      if (!accepted.ok) {
        return accepted;
      }
      moves.push(accepted.value);
      const outcome = rules.outcome();
      if (outcome !== null) {
        return transition({ type: "complete", outcome });
      }
      return success(snapshot());
    },
  });
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
  const game = createGame();
  if (lifecycle.state === "configuring") {
    return input.moves.length === 0 ? success(game) : failure("INVALID_LIFECYCLE");
  }

  game.start();
  for (const [index, uci] of input.moves.entries()) {
    if (!game.playMove(uci).ok) {
      return failure("INVALID_HISTORY", index + 1);
    }
  }
  const replayed = game.snapshot();
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
      game.pause();
      break;
    case "aborted":
      game.abort();
      break;
    case "completed": {
      const loser = lifecycle.result === "1-0" ? "black" : "white";
      if (lifecycle.terminationReason === "human_resignation") {
        game.resignHuman(loser);
      } else if (lifecycle.terminationReason === "model_technical_loss") {
        game.recordTechnicalLoss(loser);
      } else {
        return failure("INVALID_LIFECYCLE");
      }
      break;
    }
  }
  return success(game);
}
