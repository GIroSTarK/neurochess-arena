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
  getLegalMoves,
  getCurrentTurn,
  getGameStatus,
  exportPGN,
} from '../lib/chessEngine';
import { requestLLMMove } from '../lib/llm';

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
  game: Chess;
  fen: string;
  moveHistory: MoveRecord[];
  currentTurn: PlayerColor;
  status: GameStatus;
  statusMessage: string;

  whitePlayer: PlayerConfig;
  blackPlayer: PlayerConfig;

  boardConfig: BoardConfig;

  isThinking: boolean;
  thinkingPlayer: PlayerColor | null;
  autoPlay: boolean;
  debugMode: boolean;
  debugLogs: DebugEntry[];

  startNewGame: () => void;
  makeHumanMove: (uci: string) => boolean;
  requestAIMove: () => Promise<void>;
  toggleAutoPlay: () => void;
  stopAutoPlay: () => void;
  resetGame: () => void;

  setWhitePlayer: (config: Partial<PlayerConfig>) => void;
  setBlackPlayer: (config: Partial<PlayerConfig>) => void;
  flipBoard: () => void;
  setPieceSet: (pieceSet: PieceSet) => void;
  toggleDebugMode: () => void;
  addDebugLog: (entry: DebugEntry) => void;
  clearDebugLogs: () => void;

  copyPGN: () => Promise<boolean>;
  getCurrentPlayerConfig: () => PlayerConfig;
  isCurrentPlayerAI: () => boolean;
}

export const useGameStore = create<GameStore>()(
  persist(
    (set, get) => ({
      game: createGame(),
      fen: INITIAL_FEN,
      moveHistory: [],
      currentTurn: 'white',
      status: 'idle',
      statusMessage: 'Ready to play',

      whitePlayer: { ...defaultPlayerConfig },
      blackPlayer: { ...defaultPlayerConfig },

      boardConfig: { ...defaultBoardConfig },

      isThinking: false,
      thinkingPlayer: null,
      autoPlay: false,
      debugMode: false,
      debugLogs: [],

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

      makeHumanMove: (uci: string) => {
        const { game, status, currentTurn, moveHistory } = get();

        if (status !== 'playing') {
          return false;
        }

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
          autoPlay: gameStatus.isGameOver ? false : get().autoPlay,
        });

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

        if (status !== 'playing' || get().isThinking) {
          return;
        }

        const playerConfig = currentTurn === 'white' ? whitePlayer : blackPlayer;

        if (playerConfig.type !== 'ai') {
          return;
        }

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
          const legalMoves = getLegalMoves(game);

          const response = await requestLLMMove(
            playerConfig.llmConfig,
            game.fen(),
            game.pgn(),
            currentTurn,
            moveHistorySan,
            legalMoves,
            debugMode ? get().addDebugLog : undefined
          );

          if (get().game !== gameRef) {
            return;
          }

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
            if (state.game !== gameRef) return {};
            return {
              fen: game.fen(),
              moveHistory: newMoveHistory,
              currentTurn: newTurn,
              status: newStatus,
              statusMessage: gameStatus.status,
              isThinking: false,
              thinkingPlayer: null,
              autoPlay: gameStatus.isGameOver ? false : state.autoPlay,
            };
          });

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
            if (state.game !== gameRef) return {};
            return {
              isThinking: false,
              thinkingPlayer: null,
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

      toggleAutoPlay: () => {
        const { autoPlay, status } = get();

        if (autoPlay) {
          set({ autoPlay: false });
        } else {
          if (status !== 'playing') {
            return;
          }
          set({ autoPlay: true });
          get().requestAIMove();
        }
      },

      stopAutoPlay: () => {
        set({ autoPlay: false });
      },

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

      flipBoard: () => {
        set((state) => ({
          boardConfig: {
            ...state.boardConfig,
            flipped: !state.boardConfig.flipped,
          },
        }));
      },

      setPieceSet: (pieceSet) => {
        set((state) => ({
          boardConfig: {
            ...state.boardConfig,
            pieceSet,
          },
        }));
      },

      toggleDebugMode: () => {
        set((state) => ({ debugMode: !state.debugMode }));
      },

      addDebugLog: (entry) => {
        set((state) => ({
          debugLogs: [...state.debugLogs, entry].slice(-100),
        }));
      },

      clearDebugLogs: () => {
        set({ debugLogs: [] });
      },

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

      getCurrentPlayerConfig: () => {
        const { currentTurn, whitePlayer, blackPlayer } = get();
        return currentTurn === 'white' ? whitePlayer : blackPlayer;
      },

      isCurrentPlayerAI: () => {
        const { currentTurn, whitePlayer, blackPlayer } = get();
        const config = currentTurn === 'white' ? whitePlayer : blackPlayer;
        return config.type === 'ai';
      },
    }),
    {
      name: 'neurochess-storage',
      partialize: (state) => ({
        whitePlayer: state.whitePlayer,
        blackPlayer: state.blackPlayer,
        boardConfig: state.boardConfig,
        debugMode: state.debugMode,
      }),
    }
  )
);
