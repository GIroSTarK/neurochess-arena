import type { ChessColor, ChessGame } from "@neurochess/chess";
import { type ModelContext, modelContextSchema } from "@neurochess/contracts";

import { GameIntegrityError, GameRequestError } from "../games/errors.js";

// Model-facing protocol text, not UI copy. Every adapter uses this instruction unchanged.
export const MODEL_RESPONSE_INSTRUCTION =
  'Select exactly one move from legalMoves. Return a JSON object with a required "move" field ' +
  'containing that exact UCI move and an optional "commentary" string of at most 2000 characters. ' +
  "Commentary is a concise explanation for viewers. Do not include any other fields, " +
  "Markdown fences, or text outside the JSON object. You cannot resign.";

/** Call only after read/seat authorization, on the live or fully restored chess aggregate. */
export function buildModelContext(game: ChessGame, color: ChessColor): ModelContext {
  const snapshot = game.snapshot();
  if (snapshot.state !== "active" || snapshot.turn !== color) {
    throw new GameRequestError("INVALID_GAME_STATE");
  }
  // Explicit projection prevents future snapshot metadata from reaching a provider.
  const context = modelContextSchema.safeParse({
    fen: snapshot.fen,
    pgn: snapshot.pgn,
    color,
    sideToMove: snapshot.turn,
    legalMoves: [...snapshot.legalMoves],
  });
  if (!context.success) throw new GameIntegrityError();
  return context.data;
}
