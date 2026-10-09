export { createDatabase, type DatabaseConnection } from "./client.js";
export { runMigrations } from "./migrations.js";
export { rooms, roomCreationOperations } from "./schema/rooms.js";
export type {
  RoomReader,
  RoomTransaction,
  StoredRoom,
  StoredRoomCreationOperation,
} from "./room-repository.js";
export { profiles } from "./schema/profiles.js";
export {
  createProfileRepository,
  UsernameTakenError,
  type ProfileRepository,
  type StoredProfile,
} from "./profile-repository.js";
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
export {
  createAuthDatabaseAdapter,
  withAuthUserLock,
  AuthAccountUnavailableError,
  AccountDeletionSessionError,
  type AuthAccountActions,
} from "./auth-adapter.js";
export {
  user as authUsers,
  account as authAccounts,
  session as authSessions,
  verification as authVerifications,
  rateLimit as authRateLimits,
} from "./schema/auth.js";
export { providerCredentials } from "./schema/credentials.js";
export {
  createCredentialRepository,
  type CredentialRepository,
  type NewCredential,
  type StoredCredentialMetadata,
} from "./credential-repository.js";
