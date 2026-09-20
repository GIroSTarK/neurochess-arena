import type {
  AiParameters,
  AiProvider,
  ChessColor,
  ModelCapabilities,
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
  readonly instructions: string;
  readonly modelId: string;
  readonly parameters: Readonly<AiParameters>;
  // Resolved by this request's discovery, never cached on an adapter instance.
  readonly capabilities?: ModelCapabilities;
  // Built from authoritative history; never includes identities or analysis.
  readonly context: AiChessContext;
}

export const AI_MOVE_INSTRUCTIONS =
  "Choose exactly one move from the supplied legalMoves. Return a JSON object with a required " +
  "move field containing that move in UCI notation. You may include a commentary field with " +
  "a concise explanation for viewers. Do not resign or return any other fields.";

export interface AiProviderAdapter {
  readonly provider: AiProvider;
  // Pure parameter resolution includes required wire defaults before persistence.
  readonly resolveParameters?: (
    requested: Readonly<AiParameters>,
    capabilities: ModelCapabilities,
  ) => AiParameters | null;
  listModels(input: ListModelsInput): Promise<ModelDiscoveryResult>;
  requestMove(input: MoveRequest): Promise<NormalizedMoveResponse>;
}
