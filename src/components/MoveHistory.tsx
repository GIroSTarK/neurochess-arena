import { useGameStore } from '../store/gameStore';
import { getMaterialBalance } from '../lib/chessEngine';
import { useMemo } from 'react';

export function MoveHistory() {
  const { game, moveHistory, fen } = useGameStore();

  // Calculate material balance
  // Note: `game` is mutable and doesn't change reference, so we use `fen` to trigger recalculation
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const material = useMemo(() => getMaterialBalance(game), [fen]);

  // Group moves into pairs (white, black)
  const movePairs = useMemo(() => {
    const pairs: { number: number; white?: string; black?: string }[] = [];

    for (let i = 0; i < moveHistory.length; i += 2) {
      const moveNumber = Math.floor(i / 2) + 1;
      pairs.push({
        number: moveNumber,
        white: moveHistory[i]?.san,
        black: moveHistory[i + 1]?.san,
      });
    }

    return pairs;
  }, [moveHistory]);

  // Render piece symbols
  const renderPieces = (count: number, symbol: string) => {
    return Array(count).fill(symbol).join('');
  };

  return (
    <div className="glass-panel p-4 min-h-[410px] max-h-[500px] flex flex-col overflow-hidden">
      {/* Header */}
      <h3 className="text-lg font-semibold text-(--text-primary) border-b border-(--border-color) pb-3 mb-3">
        📜 Move History
      </h3>

      {/* Material Balance */}
      <div className="bg-(--bg-secondary) rounded-lg p-3 mb-4">
        <div className="text-xs text-(--text-muted) uppercase tracking-wider mb-2">
          Material Balance
        </div>

        <div className="space-y-2">
          {/* White material */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 bg-white rounded-full shadow-sm" />
              <span className="text-sm text-(--text-secondary)">White</span>
            </div>
            <div className="text-right">
              <span className="text-lg font-mono font-bold text-(--text-primary)">
                {material.whiteTotal}
              </span>
            </div>
          </div>

          {/* White pieces display */}
          <div className="text-sm text-(--text-muted) pl-6">
            {renderPieces(material.white.queens, '♕')}
            {renderPieces(material.white.rooks, '♖')}
            {renderPieces(material.white.bishops, '♗')}
            {renderPieces(material.white.knights, '♘')}
            {renderPieces(material.white.pawns, '♙')}
          </div>

          {/* Black material */}
          <div className="flex items-center justify-between mt-3">
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 bg-[#333] rounded-full shadow-sm border border-(--border-color)" />
              <span className="text-sm text-(--text-secondary)">Black</span>
            </div>
            <div className="text-right">
              <span className="text-lg font-mono font-bold text-(--text-primary)">
                {material.blackTotal}
              </span>
            </div>
          </div>

          {/* Black pieces display */}
          <div className="text-sm text-(--text-muted) pl-6">
            {renderPieces(material.black.queens, '♛')}
            {renderPieces(material.black.rooks, '♜')}
            {renderPieces(material.black.bishops, '♝')}
            {renderPieces(material.black.knights, '♞')}
            {renderPieces(material.black.pawns, '♟')}
          </div>
        </div>

        {/* Advantage indicator */}
        <div className="mt-3 pt-3 border-t border-(--border-color)">
          <div
            className={`text-center text-sm font-medium ${
              material.advantage === 'equal'
                ? 'text-(--text-muted)'
                : material.advantage === 'white'
                  ? 'text-(--accent-success)'
                  : 'text-(--accent-warning)'
            }`}
          >
            {material.advantage === 'equal'
              ? '= Equal material'
              : `${material.advantage === 'white' ? '♔' : '♚'} ${material.advantage.charAt(0).toUpperCase() + material.advantage.slice(1)} +${material.advantageValue}`}
          </div>
        </div>
      </div>

      {/* Moves List */}
      <div className="flex-1 overflow-y-auto">
        {movePairs.length === 0 ? (
          <div className="text-center text-(--text-muted) py-8">
            No moves yet. Start a new game!
          </div>
        ) : (
          <div className="space-y-1">
            {movePairs.map((pair) => (
              <div
                key={pair.number}
                className="flex items-center text-sm hover:bg-(--bg-secondary) rounded px-2 py-1 transition-colors"
              >
                <span className="w-8 text-(--text-muted) font-mono">{pair.number}.</span>
                <span className="flex-1 mono text-(--text-primary)">{pair.white || '...'}</span>
                <span className="flex-1 mono text-(--text-primary)">{pair.black || ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Move count */}
      {moveHistory.length > 0 && (
        <div className="mt-3 pt-3 border-t border-(--border-color) text-center text-xs text-(--text-muted)">
          {moveHistory.length} moves played
        </div>
      )}
    </div>
  );
}
