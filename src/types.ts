// ==========================================
// Player Types
// ==========================================

export type PlayerType = 'human' | 'ai';
export type PlayerColor = 'white' | 'black';

// ==========================================
// LLM Provider Types
// ==========================================

export type ProviderId = 'openrouter' | 'openai' | 'anthropic' | 'google' | 'xai';

export interface LLMModel {
  id: string;
  name: string;
  providerId: ProviderId;
}

export interface LLMConfig {
  providerId: ProviderId;
  modelId: string;
  customModelSlug?: string; // Overrides modelId if provided
  apiKey: string;
  temperature: number;
  maxRetries: number;
}

export interface LLMRequestConfig {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: unknown;
}

export interface LLMResponse {
  move: string; // UCI format: "e2e4"
  thoughts?: string; // Optional explanation from the model
  rawResponse?: string; // For debugging
}

// ==========================================
// Player Configuration
// ==========================================

export interface PlayerConfig {
  type: PlayerType;
  llmConfig: LLMConfig;
}

// ==========================================
// Game State Types
// ==========================================

export type GameStatus = 'idle' | 'playing' | 'white_wins' | 'black_wins' | 'draw' | 'stalemate';

export interface GameState {
  fen: string;
  pgn: string;
  moveHistory: MoveRecord[];
  currentTurn: PlayerColor;
  moveNumber: number;
  status: GameStatus;
  statusMessage?: string;
}

export interface MoveRecord {
  san: string; // Standard Algebraic Notation: "e4", "Nf3"
  uci: string; // UCI format: "e2e4", "g1f3"
  fen: string; // Position after the move
  color: PlayerColor;
  moveNumber: number;
}

// ==========================================
// Material Balance
// ==========================================

export interface MaterialCount {
  pawns: number;
  knights: number;
  bishops: number;
  rooks: number;
  queens: number;
}

export interface MaterialBalance {
  white: MaterialCount;
  black: MaterialCount;
  whiteTotal: number;
  blackTotal: number;
  advantage: 'white' | 'black' | 'equal';
  advantageValue: number;
}

// ==========================================
// UI Configuration
// ==========================================

export type PieceSet = 'default' | 'neo' | 'alpha' | 'merida' | 'cburnett';

export interface BoardConfig {
  flipped: boolean;
  pieceSet: PieceSet;
  showCoordinates: boolean;
}

// ==========================================
// Debug Types
// ==========================================

export interface DebugEntry {
  timestamp: Date;
  type: 'prompt' | 'response' | 'error' | 'move';
  player: PlayerColor;
  content: string;
  raw?: string;
}

// ==========================================
// LLM Provider Interface
// ==========================================

export interface LLMProvider {
  id: ProviderId;
  name: string;
  models: LLMModel[];
  buildRequest(prompt: string, config: LLMConfig): LLMRequestConfig;
  parseResponse(responseJson: unknown): LLMResponse;
}

// ==========================================
// Constants
// ==========================================

export const PIECE_VALUES = {
  p: 1, // pawn
  n: 3, // knight
  b: 3, // bishop
  r: 5, // rook
  q: 9, // queen
  k: 0, // king (infinite value, but 0 for material count)
} as const;

export const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  providerId: 'openrouter',
  modelId: 'openai/gpt-4o',
  apiKey: '',
  temperature: 0.3,
  maxRetries: 3,
};

export const DEFAULT_PLAYER_CONFIG: PlayerConfig = {
  type: 'human',
  llmConfig: { ...DEFAULT_LLM_CONFIG },
};
