import type {
  GamePgnResponse,
  GameReplayResponse,
  GameSnapshot,
  LifecycleCommand,
  MoveCommand,
} from "@neurochess/contracts";

export interface GameCommandApi {
  bootstrap(signal: AbortSignal): Promise<void>;
  snapshot(gameId: string, signal: AbortSignal): Promise<GameSnapshot>;
  move(command: MoveCommand, signal: AbortSignal): Promise<GameSnapshot>;
  lifecycle(command: LifecycleCommand, signal: AbortSignal): Promise<GameSnapshot>;
  replay(gameId: string, signal: AbortSignal): Promise<GameReplayResponse>;
  pgn(gameId: string, signal: AbortSignal): Promise<GamePgnResponse>;
}
