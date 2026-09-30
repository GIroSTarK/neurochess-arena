export { createDatabase, type DatabaseConnection } from "./client.js";
export { runMigrations } from "./migrations.js";
export {
  games,
  gameParticipants,
  guestSessions,
  moves,
  gameCommands,
  aiTurnReservations,
  aiControllers,
  aiTurns,
  modelInvocations,
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
  type StoredAiTurn,
  type StoredModelInvocation,
  type NewModelInvocation,
  type InvocationResult,
  type GamePositionUpdate,
} from "./game-repository.js";
export { createAuthDatabaseAdapter } from "./auth-adapter.js";
export {
  user as authUsers,
  account as authAccounts,
  session as authSessions,
  verification as authVerifications,
  rateLimit as authRateLimits,
} from "./schema/auth.js";
