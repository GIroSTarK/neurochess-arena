export { createDatabase, type DatabaseConnection } from "./client.js";
export { runMigrations } from "./migrations.js";
export {
  games,
  gameParticipants,
  guestSessions,
  moves,
  gameCommands,
  aiTurnReservations,
  type StoredAiParameters,
} from "./schema/index.js";
export {
  createGameRepository,
  type GameRepository,
  type GameReader,
  type GameTransaction,
  type StoredGuestSession,
  type StoredGame,
  type StoredParticipant,
  type StoredMove,
  type NewGame,
  type NewParticipant,
  type NewMove,
  type NewGameCommand,
  type NewAiTurnReservation,
  type StoredAiTurnReservation,
  type GamePositionUpdate,
} from "./game-repository.js";
