import { Chessboard } from 'react-chessboard';
import { useGameStore } from '../store/gameStore';
import { useState, useMemo, useCallback } from 'react';

// Types matching react-chessboard's internal types
interface PieceDataType {
  pieceType: string;
}

interface DraggingPieceDataType {
  isSparePiece: boolean;
  position: string;
  pieceType: string;
}

interface SquareHandlerArgs {
  piece: PieceDataType | null;
  square: string;
}

interface PieceHandlerArgs {
  isSparePiece: boolean;
  piece: PieceDataType;
  square: string | null;
}

interface PieceDropHandlerArgs {
  piece: DraggingPieceDataType;
  sourceSquare: string;
  targetSquare: string | null;
}

export function ChessBoardComponent() {
  const {
    fen,
    boardConfig,
    isThinking,
    currentTurn,
    status,
    whitePlayer,
    blackPlayer,
    makeHumanMove,
  } = useGameStore();

  const [moveFrom, setMoveFrom] = useState<string | null>(null);

  // Check if it's human's turn to move
  const isHumanTurn = useCallback(() => {
    if (status !== 'playing' && status !== 'idle') return false;
    const currentPlayer = currentTurn === 'white' ? whitePlayer : blackPlayer;
    return currentPlayer.type === 'human';
  }, [status, currentTurn, whitePlayer, blackPlayer]);

  // Handle piece drop (drag and drop)
  const onPieceDrop = useCallback(
    ({ piece, sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean => {
      if (!isHumanTurn() || isThinking || !targetSquare) {
        return false;
      }

      // Handle promotion (piece.pieceType is like 'wP' or 'bP')
      const pieceType = piece.pieceType;
      const isPawn = pieceType[1] === 'P';
      const isPromotion = isPawn && (targetSquare[1] === '8' || targetSquare[1] === '1');
      const promotion = isPromotion ? 'q' : ''; // Default to queen promotion

      const uci = `${sourceSquare}${targetSquare}${promotion}`;
      return makeHumanMove(uci);
    },
    [isHumanTurn, isThinking, makeHumanMove]
  );

  // Handle square click (click-to-move)
  const onSquareClick = useCallback(
    ({ square }: SquareHandlerArgs) => {
      if (!isHumanTurn() || isThinking) {
        return;
      }

      if (moveFrom) {
        // Try to make the move
        const uci = `${moveFrom}${square}`;
        let success = makeHumanMove(uci);

        // If not successful and target is last rank, try with queen promotion
        if (!success && (square[1] === '8' || square[1] === '1')) {
          success = makeHumanMove(`${moveFrom}${square}q`);
        }

        setMoveFrom(null);
      } else {
        setMoveFrom(square);
      }
    },
    [isHumanTurn, isThinking, moveFrom, makeHumanMove]
  );

  // Check if piece is draggable
  const canDragPiece = useCallback(
    ({ piece }: PieceHandlerArgs): boolean => {
      if (!isHumanTurn() || isThinking) return false;

      // Only allow dragging pieces of current turn color
      const pieceColor = piece.pieceType[0] === 'w' ? 'white' : 'black';
      return pieceColor === currentTurn;
    },
    [isHumanTurn, isThinking, currentTurn]
  );

  // Custom square styles
  const squareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};

    // Highlight selected square
    if (moveFrom) {
      styles[moveFrom] = {
        backgroundColor: 'rgba(124, 92, 255, 0.4)',
      };
    }

    return styles;
  }, [moveFrom]);

  // Board colors matching our theme
  const lightSquareStyle: React.CSSProperties = { backgroundColor: '#e8dcc8' };
  const darkSquareStyle: React.CSSProperties = { backgroundColor: '#7d945d' };

  return (
    <div className="relative">
      {/* Thinking overlay */}
      {isThinking && (
        <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px] z-10 flex items-center justify-center rounded-lg">
          <div className="flex items-center gap-3 glass-panel px-5 py-3">
            <div className="animate-spin w-5 h-5 border-2 border-(--accent-primary) border-t-transparent rounded-full" />
            <span className="text-(--text-primary) font-medium">
              {currentTurn === 'white' ? 'White' : 'Black'} AI thinking...
            </span>
          </div>
        </div>
      )}

      {/* Chess board */}
      <div
        className="rounded-lg overflow-hidden shadow-2xl glow-accent"
        style={{ width: '480px', height: '480px' }}
      >
        <Chessboard
          options={{
            position: fen,
            boardOrientation: boardConfig.flipped ? 'black' : 'white',
            boardStyle: {
              borderRadius: '8px',
            },
            lightSquareStyle,
            darkSquareStyle,
            squareStyles,
            allowDragging: isHumanTurn() && !isThinking,
            canDragPiece,
            onPieceDrop,
            onSquareClick,
            showNotation: boardConfig.showCoordinates,
          }}
        />
      </div>
    </div>
  );
}
