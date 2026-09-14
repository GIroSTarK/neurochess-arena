import type {
  AiParameters,
  AiProvider,
  ChessColor,
  ModelDiscoveryResult,
  NormalizedMoveResponse,
  UciMove,
} from "@neurochess/contracts";

export interface ListModelsInput {
  // Request-scoped only: adapters must not retain credentials on an instance.
  readonly apiKey: string;
  readonly signal: AbortSignal;
}

export interface AiChessContext {
  readonly fen: string;
  readonly pgn: string;
  readonly color: ChessColor;
  readonly turn: ChessColor;
  readonly legalMoves: readonly UciMove[];
}

export interface MoveRequest extends ListModelsInput {
  readonly modelId: string;
  readonly parameters: Readonly<AiParameters>;
  // Built from authoritative history; never includes identities or analysis.
  readonly context: AiChessContext;
}

export interface AiProviderAdapter {
  readonly provider: AiProvider;
  listModels(input: ListModelsInput): Promise<ModelDiscoveryResult>;
  requestMove(input: MoveRequest): Promise<NormalizedMoveResponse>;
}
