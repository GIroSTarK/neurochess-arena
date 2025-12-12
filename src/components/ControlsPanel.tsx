import { useGameStore } from '../store/gameStore';
import { useState } from 'react';

export function ControlsPanel() {
  const {
    status,
    statusMessage,
    currentTurn,
    moveHistory,
    isThinking,
    autoPlay,
    whitePlayer,
    blackPlayer,
    startNewGame,
    requestAIMove,
    toggleAutoPlay,
    stopAutoPlay,
    resetGame,
    flipBoard,
    copyPGN,
  } = useGameStore();

  const [copySuccess, setCopySuccess] = useState(false);

  const isAiError = statusMessage.startsWith('AI Error:');
  const isGameOver = ['white_wins', 'black_wins', 'draw', 'stalemate'].includes(status);
  const isGameActive = status === 'playing';
  const canMakeMove = isGameActive && !isThinking;

  const currentPlayerConfig = currentTurn === 'white' ? whitePlayer : blackPlayer;
  const isCurrentPlayerAI = currentPlayerConfig.type === 'ai';

  const isBothAI = whitePlayer.type === 'ai' && blackPlayer.type === 'ai';

  const handleCopyPGN = async () => {
    const success = await copyPGN();
    if (success) {
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    }
  };

  const getStatusColor = () => {
    if (status === 'white_wins') return 'text-[var(--accent-success)]';
    if (status === 'black_wins') return 'text-[var(--accent-success)]';
    if (status === 'draw' || status === 'stalemate') return 'text-[var(--accent-warning)]';
    if (isAiError) return 'text-[var(--accent-danger)]';
    if (isThinking) return 'text-[var(--accent-secondary)]';
    return 'text-[var(--text-primary)]';
  };

  return (
    <div className="glass-panel p-4 space-y-4">
      <div className="text-center p-3 bg-(--bg-secondary) rounded-lg">
        <div className="text-xs text-(--text-muted) uppercase tracking-wider mb-1">Game Status</div>
        <div className={`font-semibold ${getStatusColor()}`}>{statusMessage}</div>
        {moveHistory.length > 0 && (
          <div className="text-xs text-(--text-muted) mt-1">
            Move {Math.ceil(moveHistory.length / 2)} • {moveHistory.length} half-moves
          </div>
        )}
      </div>

      {!isGameOver && (
        <div className="flex items-center justify-center gap-3 py-2">
          <div
            className={`w-3 h-3 rounded-full ${
              currentTurn === 'white' ? 'bg-white ring-2 ring-(--accent-primary)' : 'bg-white/30'
            }`}
          />
          <span
            className={`text-sm ${currentTurn === 'white' ? 'text-(--text-primary)' : 'text-(--text-muted)'}`}
          >
            White
          </span>
          <span className="text-(--text-muted)">vs</span>
          <span
            className={`text-sm ${currentTurn === 'black' ? 'text-(--text-primary)' : 'text-(--text-muted)'}`}
          >
            Black
          </span>
          <div
            className={`w-3 h-3 rounded-full ${
              currentTurn === 'black' ? 'bg-[#333] ring-2 ring-(--accent-primary)' : 'bg-[#333]/50'
            }`}
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button className="btn btn-success" onClick={startNewGame} disabled={isThinking}>
          🎮 New Game
        </button>

        <button className="btn btn-secondary" onClick={resetGame} disabled={isThinking}>
          ⏹️ End Game
        </button>

        {isCurrentPlayerAI && canMakeMove && !autoPlay && (
          <button
            className="btn btn-primary col-span-2"
            onClick={requestAIMove}
            disabled={isThinking}
          >
            {isThinking ? (
              <>
                <span className="animate-spin">⟳</span> Thinking...
              </>
            ) : (
              <>🤖 Make AI Move</>
            )}
          </button>
        )}

        {isBothAI && (
          <button
            className={`btn col-span-2 ${autoPlay ? 'btn-danger' : 'btn-secondary'}`}
            onClick={autoPlay ? stopAutoPlay : toggleAutoPlay}
            disabled={autoPlay ? false : !isGameActive || isThinking}
          >
            {autoPlay ? <>⏹️ Stop Auto-Play</> : <>▶️ Auto-Play (LLM vs LLM)</>}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button className="btn btn-secondary" onClick={flipBoard}>
          🔄 Flip Board
        </button>

        <button
          className="btn btn-secondary"
          onClick={handleCopyPGN}
          disabled={moveHistory.length === 0}
        >
          {copySuccess ? '✓ Copied!' : '📋 Copy PGN'}
        </button>
      </div>

      <div className="text-xs text-(--text-muted) bg-(--bg-secondary) p-3 rounded-lg">
        <div className="flex items-start gap-2">
          <span className="text-(--accent-warning)">🔒</span>
          <div>
            <strong className="text-(--text-secondary)">Security Note:</strong>
            <p className="mt-1">
              Your API keys are stored locally in your browser and are only used to make requests
              directly to the selected LLM providers. Keys are never sent to any other servers.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
