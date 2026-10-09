import type { games, moves } from "./schema/games.js";

export type StoredGame = typeof games.$inferSelect;
export type StoredMove = typeof moves.$inferSelect;
export type GamePositionUpdate = Pick<
  StoredGame,
  "state" | "result" | "terminationReason" | "fen" | "pgn" | "version"
>;
