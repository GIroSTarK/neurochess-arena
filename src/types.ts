export type PlayerType = 'human' | 'ai';
export type PlayerColor = 'white' | 'black';

export type ProviderId = 'openrouter' | 'openai' | 'anthropic' | 'google' | 'xai';

export interface LLMModel {
  id: string;
  name: string;
  providerId: ProviderId;
}

export interface LLMConfig {
  providerId: ProviderId;
  modelId: string;
  customModelSlug?: string;
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
  move: string;
  thoughts?: string;
  rawResponse?: string;
}

export interface PlayerConfig {
  type: PlayerType;
  llmConfig: LLMConfig;
}

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
  san: string;
  uci: string;
  fen: string;
  color: PlayerColor;
  moveNumber: number;
}

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

export type PieceSet = 'default' | 'neo' | 'alpha' | 'merida' | 'cburnett';

export interface BoardConfig {
  flipped: boolean;
  pieceSet: PieceSet;
  showCoordinates: boolean;
}

export interface DebugEntry {
  timestamp: Date;
  type: 'prompt' | 'response' | 'error' | 'move';
  player: PlayerColor;
  content: string;
  raw?: string;
}

export interface ChessPrompt {
  system: string;
  user: string;
}

export interface LLMProvider {
  id: ProviderId;
  name: string;
  models: LLMModel[];
  buildRequest(prompt: ChessPrompt, config: LLMConfig): LLMRequestConfig;
  parseResponse(responseJson: unknown): LLMResponse;
}

export const PIECE_VALUES = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
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
