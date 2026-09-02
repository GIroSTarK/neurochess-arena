export { createDatabase, type DatabaseConnection } from "./client.js";
export { runMigrations } from "./migrations.js";
export { games, gameParticipants, guestSessions, moves } from "./schema/index.js";
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
  type GamePositionUpdate,
} from "./game-repository.js";
