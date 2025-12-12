import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Chess } from 'chess.js';
import type {
  PlayerConfig,
  PlayerColor,
  GameStatus,
  MoveRecord,
  BoardConfig,
  DebugEntry,
  PieceSet,
} from '../types';
import { INITIAL_FEN } from '../types';
import {
  createGame,
  makeMove,
  isLegalMove,
  getCurrentTurn,
  getGameStatus,
  exportPGN,
} from '../lib/chessEngine';
import { requestLLMMove } from '../lib/llm';

// Default configurations
const defaultPlayerConfig: PlayerConfig = {
  type: 'human',
  llmConfig: {
    providerId: 'openrouter',
    modelId: 'openai/gpt-4o',
    apiKey: '',
    temperature: 0.3,
    maxRetries: 3,
  },
};

const defaultBoardConfig: BoardConfig = {
  flipped: false,
  pieceSet: 'default',
  showCoordinates: true,
};

interface GameStore {
  // Game state
  game: Chess;
  fen: string;
  moveHistory: MoveRecord[];
  currentTurn: PlayerColor;
  status: GameStatus;
  statusMessage: string;

  // Player configurations
  whitePlayer: PlayerConfig;
  blackPlayer: PlayerConfig;

  // Board configuration
  boardConfig: BoardConfig;

  // UI state
  isThinking: boolean;
  thinkingPlayer: PlayerColor | null;
  autoPlay: boolean;
  debugMode: boolean;
  debugLogs: DebugEntry[];

  // Actions
  startNewGame: () => void;
  makeHumanMove: (uci: string) => boolean;
  requestAIMove: () => Promise<void>;
  toggleAutoPlay: () => void;
  stopAutoPlay: () => void;
  resetGame: () => void;

  // Configuration actions
  setWhitePlayer: (config: Partial<PlayerConfig>) => void;
  setBlackPlayer: (config: Partial<PlayerConfig>) => void;
  flipBoard: () => void;
  setPieceSet: (pieceSet: PieceSet) => void;
  toggleDebugMode: () => void;
  addDebugLog: (entry: DebugEntry) => void;
  clearDebugLogs: () => void;

  // Utility
  copyPGN: () => Promise<boolean>;
  getCurrentPlayerConfig: () => PlayerConfig;
  isCurrentPlayerAI: () => boolean;
}

export const useGameStore = create<GameStore>()(
  persist(
    (set, get) => ({
      // Initial game state
      game: createGame(),
      fen: INITIAL_FEN,
      moveHistory: [],
      currentTurn: 'white',
      status: 'idle',
      statusMessage: 'Ready to play',

      // Player configurations
      whitePlayer: { ...defaultPlayerConfig },
      blackPlayer: { ...defaultPlayerConfig },

      // Board configuration
      boardConfig: { ...defaultBoardConfig },

      // UI state
      isThinking: false,
      thinkingPlayer: null,
      autoPlay: false,
      debugMode: false,
      debugLogs: [],

      // Start a new game
      startNewGame: () => {
        const newGame = createGame();
        set({
          game: newGame,
          fen: newGame.fen(),
          moveHistory: [],
          currentTurn: 'white',
          status: 'playing',
          statusMessage: 'White to move',
          isThinking: false,
          thinkingPlayer: null,
          autoPlay: false,
        });
      },

      // Make a human move
      makeHumanMove: (uci: string) => {
        const { game, status, currentTurn, moveHistory } = get();

        // Only allow moves when game is actively playing
        if (status !== 'playing') {
          return false;
        }

        // Check if it's the human's turn
        const playerConfig = currentTurn === 'white' ? get().whitePlayer : get().blackPlayer;

        if (playerConfig.type !== 'human') {
          return false;
        }

        if (!isLegalMove(game, uci)) {
          return false;
        }

        const moveRecord = makeMove(game, uci);
        if (!moveRecord) {
          return false;
        }

        const newMoveHistory = [...moveHistory, moveRecord];
        const gameStatus = getGameStatus(game);
        const newTurn = getCurrentTurn(game);

        let newStatus: GameStatus = 'playing';
        if (gameStatus.isGameOver) {
          if (gameStatus.winner === 'white') newStatus = 'white_wins';
          else if (gameStatus.winner === 'black') newStatus = 'black_wins';
          else newStatus = 'draw';
        }

        set({
          fen: game.fen(),
          moveHistory: newMoveHistory,
          currentTurn: newTurn,
          status: newStatus,
          statusMessage: gameStatus.status,
        });

        // Log the move in debug mode
        if (get().debugMode) {
          get().addDebugLog({
            timestamp: new Date(),
            type: 'move',
            player: currentTurn,
            content: `Human played: ${moveRecord.san} (${uci})`,
          });
        }

        return true;
      },

      // Request an AI move
      requestAIMove: async () => {
        const {
          game,
          status,
          currentTurn,
          moveHistory,
          whitePlayer,
          blackPlayer,
          debugMode,
          autoPlay,
        } = get();
        const gameRef = game;

        // Don't proceed if game is not actively playing or already thinking
        if (status !== 'playing' || get().isThinking) {
          return;
        }

        const playerConfig = currentTurn === 'white' ? whitePlayer : blackPlayer;

        // Only proceed if current player is AI
        if (playerConfig.type !== 'ai') {
          return;
        }

        // Check if API key is set
        if (!playerConfig.llmConfig.apiKey) {
          set({
            statusMessage: `${currentTurn === 'white' ? 'White' : 'Black'} AI needs an API key`,
          });
          return;
        }

        set({
          isThinking: true,
          thinkingPlayer: currentTurn,
          statusMessage: `${currentTurn === 'white' ? 'White' : 'Black'} AI is thinking...`,
        });

        try {
          const moveHistorySan = moveHistory.map((m) => m.san);

          const response = await requestLLMMove(
            playerConfig.llmConfig,
            game.fen(),
            game.pgn(),
            currentTurn,
            moveHistorySan,
            debugMode ? get().addDebugLog : undefined
          );

          // If the game was reset/restarted while we were waiting for the LLM,
          // ignore this response to avoid corrupting the new game state.
          if (get().game !== gameRef) {
            return;
          }

          // Validate and make the move
          if (!isLegalMove(game, response.move)) {
            throw new Error(`Illegal move from AI: ${response.move}`);
          }

          const moveRecord = makeMove(game, response.move);
          if (!moveRecord) {
            throw new Error(`Failed to make move: ${response.move}`);
          }

          const newMoveHistory = [...get().moveHistory, moveRecord];
          const gameStatus = getGameStatus(game);
          const newTurn = getCurrentTurn(game);

          let newStatus: GameStatus = 'playing';
          if (gameStatus.isGameOver) {
            if (gameStatus.winner === 'white') newStatus = 'white_wins';
            else if (gameStatus.winner === 'black') newStatus = 'black_wins';
            else newStatus = 'draw';
          }

          set((state) => {
            // Atomic guard: don't apply results to a different/new game.
            if (state.game !== gameRef) return {};
            return {
              fen: game.fen(),
              moveHistory: newMoveHistory,
              currentTurn: newTurn,
              status: newStatus,
              statusMessage: gameStatus.status,
              isThinking: false,
              thinkingPlayer: null,
            };
          });

          // Log the successful move
          if (debugMode && get().game === gameRef) {
            get().addDebugLog({
              timestamp: new Date(),
              type: 'move',
              player: currentTurn,
              content: `AI played: ${moveRecord.san} (${response.move})${
                response.thoughts ? `\nReason: ${response.thoughts}` : ''
              }`,
            });
          }

          // Continue auto-play if enabled and game is not over
          // Check get().autoPlay inside setTimeout to handle race condition
          // when user stops auto-play during the delay
          if (autoPlay && newStatus === 'playing') {
            setTimeout(() => {
              if (get().autoPlay && get().status === 'playing') {
                get().requestAIMove();
              }
            }, 500);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          set((state) => {
            // Atomic guard: don't surface errors from an old request onto a new game.
            if (state.game !== gameRef) return {};
            return {
              isThinking: false,
              thinkingPlayer: null,
              status: 'ai_error',
              statusMessage: `AI Error: ${errorMessage}`,
              autoPlay: false,
            };
          });

          if (debugMode && get().game === gameRef) {
            get().addDebugLog({
              timestamp: new Date(),
              type: 'error',
              player: currentTurn,
              content: `AI failed: ${errorMessage}`,
            });
          }
        }
      },

      // Toggle auto-play mode
      toggleAutoPlay: () => {
        const { autoPlay, status } = get();

        if (autoPlay) {
          set({ autoPlay: false });
        } else {
          set({ autoPlay: true });
          // Start auto-play if game is actively playing
          if (status === 'playing') {
            get().requestAIMove();
          }
        }
      },

      // Stop auto-play
      stopAutoPlay: () => {
        set({ autoPlay: false });
      },

      // Reset game to initial idle state (allows changing player types)
      resetGame: () => {
        const newGame = createGame();
        set({
          game: newGame,
          fen: newGame.fen(),
          moveHistory: [],
          currentTurn: 'white',
          status: 'idle',
          statusMessage: 'Ready to play',
          isThinking: false,
          thinkingPlayer: null,
          autoPlay: false,
        });
      },

      // Set white player configuration
      setWhitePlayer: (config) => {
        set((state) => ({
          whitePlayer: {
            ...state.whitePlayer,
            ...config,
            llmConfig: config.llmConfig
              ? { ...state.whitePlayer.llmConfig, ...config.llmConfig }
              : state.whitePlayer.llmConfig,
          },
        }));
      },

      // Set black player configuration
      setBlackPlayer: (config) => {
        set((state) => ({
          blackPlayer: {
            ...state.blackPlayer,
            ...config,
            llmConfig: config.llmConfig
              ? { ...state.blackPlayer.llmConfig, ...config.llmConfig }
              : state.blackPlayer.llmConfig,
          },
        }));
      },

      // Flip the board
      flipBoard: () => {
        set((state) => ({
          boardConfig: {
            ...state.boardConfig,
            flipped: !state.boardConfig.flipped,
          },
        }));
      },

      // Set piece set
      setPieceSet: (pieceSet) => {
        set((state) => ({
          boardConfig: {
            ...state.boardConfig,
            pieceSet,
          },
        }));
      },

      // Toggle debug mode
      toggleDebugMode: () => {
        set((state) => ({ debugMode: !state.debugMode }));
      },

      // Add debug log entry
      addDebugLog: (entry) => {
        set((state) => ({
          debugLogs: [...state.debugLogs, entry].slice(-100), // Keep last 100 entries
        }));
      },

      // Clear debug logs
      clearDebugLogs: () => {
        set({ debugLogs: [] });
      },

      // Copy PGN to clipboard
      copyPGN: async () => {
        const { game, whitePlayer, blackPlayer } = get();

        const whiteName =
          whitePlayer.type === 'human'
            ? 'Human'
            : `AI (${whitePlayer.llmConfig.customModelSlug || whitePlayer.llmConfig.modelId})`;
        const blackName =
          blackPlayer.type === 'human'
            ? 'Human'
            : `AI (${blackPlayer.llmConfig.customModelSlug || blackPlayer.llmConfig.modelId})`;

        const pgn = exportPGN(game, whiteName, blackName);

        try {
          await navigator.clipboard.writeText(pgn);
          return true;
        } catch {
          return false;
        }
      },

      // Get current player config
      getCurrentPlayerConfig: () => {
        const { currentTurn, whitePlayer, blackPlayer } = get();
        return currentTurn === 'white' ? whitePlayer : blackPlayer;
      },

      // Check if current player is AI
      isCurrentPlayerAI: () => {
        const { currentTurn, whitePlayer, blackPlayer } = get();
        const config = currentTurn === 'white' ? whitePlayer : blackPlayer;
        return config.type === 'ai';
      },
    }),
    {
      name: 'neurochess-storage',
      partialize: (state) => ({
        // Only persist player configs and board settings, not game state
        whitePlayer: state.whitePlayer,
        blackPlayer: state.blackPlayer,
        boardConfig: state.boardConfig,
        debugMode: state.debugMode,
      }),
    }
  )
);
