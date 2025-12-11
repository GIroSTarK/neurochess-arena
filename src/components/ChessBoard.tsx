import { Chessboard } from 'react-chessboard';
import { useGameStore } from '../store/gameStore';
import { getLegalMovesFromSquare } from '../lib/chessEngine';
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

// Promotion pieces with their symbols
const PROMOTION_PIECES = [
  { piece: 'q', symbol: '♛', name: 'Queen' },
  { piece: 'r', symbol: '♜', name: 'Rook' },
  { piece: 'b', symbol: '♝', name: 'Bishop' },
  { piece: 'n', symbol: '♞', name: 'Knight' },
] as const;

interface PendingPromotion {
  from: string;
  to: string;
}

export function ChessBoardComponent() {
  const {
    game,
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
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion | null>(null);

  // Check if it's human's turn to move (only when game is actively playing)
  const isHumanTurn = useCallback(() => {
    if (status !== 'playing') return false;
    const currentPlayer = currentTurn === 'white' ? whitePlayer : blackPlayer;
    return currentPlayer.type === 'human';
  }, [status, currentTurn, whitePlayer, blackPlayer]);

  // Check if a move is a legal pawn promotion
  const isPromotionMove = useCallback(
    (from: string, to: string): boolean => {
      const piece = game.get(from as Parameters<typeof game.get>[0]);
      if (!piece || piece.type !== 'p') return false;

      // Check if target is on the last rank
      if (to[1] !== '8' && to[1] !== '1') return false;

      // Verify this is actually a legal move by checking if promotion moves exist
      const moves = game.moves({ square: from as Parameters<typeof game.get>[0], verbose: true });
      return moves.some((move) => move.to === to && move.promotion);
    },
    [game]
  );

  // Handle promotion piece selection
  const handlePromotionSelect = useCallback(
    (promotionPiece: string) => {
      if (!pendingPromotion) return;

      const uci = `${pendingPromotion.from}${pendingPromotion.to}${promotionPiece}`;
      makeHumanMove(uci);
      setPendingPromotion(null);
      setMoveFrom(null);
    },
    [pendingPromotion, makeHumanMove]
  );

  // Cancel promotion dialog
  const handlePromotionCancel = useCallback(() => {
    setPendingPromotion(null);
  }, []);

  // Handle piece drop (drag and drop)
  const onPieceDrop = useCallback(
    ({ piece, sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean => {
      if (!isHumanTurn() || isThinking || !targetSquare) {
        return false;
      }

      // Check if this is a promotion move
      const pieceType = piece.pieceType;
      const isPawn = pieceType[1] === 'P';
      const isPromotion = isPawn && (targetSquare[1] === '8' || targetSquare[1] === '1');

      if (isPromotion) {
        // Show promotion dialog instead of auto-promoting to queen
        setPendingPromotion({ from: sourceSquare, to: targetSquare });
        return true; // Return true to show the piece moved visually
      }

      const uci = `${sourceSquare}${targetSquare}`;
      return makeHumanMove(uci);
    },
    [isHumanTurn, isThinking, makeHumanMove]
  );

  // Handle square click (click-to-move)
  const onSquareClick = useCallback(
    ({ piece, square }: SquareHandlerArgs) => {
      if (!isHumanTurn() || isThinking || pendingPromotion) {
        return;
      }

      // Check if clicked square has our own piece
      const isOwnPiece =
        piece &&
        ((currentTurn === 'white' && piece.pieceType[0] === 'w') ||
          (currentTurn === 'black' && piece.pieceType[0] === 'b'));

      if (moveFrom) {
        // Clicking on the same square - deselect
        if (square === moveFrom) {
          setMoveFrom(null);
          return;
        }

        // Clicking on another own piece - select that piece instead
        if (isOwnPiece) {
          setMoveFrom(square);
          return;
        }

        // Check if this is a promotion move
        if (isPromotionMove(moveFrom, square)) {
          setPendingPromotion({ from: moveFrom, to: square });
          return;
        }

        // Try to make the move
        const uci = `${moveFrom}${square}`;
        makeHumanMove(uci);
        setMoveFrom(null);
      } else {
        // Only select if it's our own piece
        if (isOwnPiece) {
          setMoveFrom(square);
        }
      }
    },
    [
      isHumanTurn,
      isThinking,
      moveFrom,
      makeHumanMove,
      currentTurn,
      isPromotionMove,
      pendingPromotion,
    ]
  );

  // Check if piece is draggable
  const canDragPiece = useCallback(
    ({ piece }: PieceHandlerArgs): boolean => {
      if (!isHumanTurn() || isThinking || pendingPromotion) return false;

      // Only allow dragging pieces of current turn color
      const pieceColor = piece.pieceType[0] === 'w' ? 'white' : 'black';
      return pieceColor === currentTurn;
    },
    [isHumanTurn, isThinking, currentTurn, pendingPromotion]
  );

  // Get legal moves for selected piece
  const legalMoves = useMemo(() => {
    if (!moveFrom) return [];
    return getLegalMovesFromSquare(game, moveFrom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveFrom, fen]); // Use fen to recalculate when position changes

  // Custom square styles
  const squareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};

    // Highlight selected square
    if (moveFrom) {
      styles[moveFrom] = {
        backgroundColor: 'rgba(124, 92, 255, 0.4)',
      };
    }

    // Highlight pending promotion squares
    if (pendingPromotion) {
      styles[pendingPromotion.from] = {
        backgroundColor: 'rgba(124, 92, 255, 0.4)',
      };
      styles[pendingPromotion.to] = {
        backgroundColor: 'rgba(124, 92, 255, 0.6)',
      };
    }

    // Show legal move indicators
    legalMoves.forEach((targetSquare) => {
      const pieceOnSquare = game.get(targetSquare as Parameters<typeof game.get>[0]);

      if (pieceOnSquare) {
        // Capture move - show ring around the square
        styles[targetSquare] = {
          ...styles[targetSquare],
          boxShadow: 'inset 0 0 0 4px rgba(124, 92, 255, 0.6)',
          borderRadius: '50%',
        };
      } else {
        // Empty square - show dot in center
        styles[targetSquare] = {
          ...styles[targetSquare],
          background: `radial-gradient(circle, rgba(124, 92, 255, 0.5) 20%, transparent 20%)`,
        };
      }
    });

    return styles;
  }, [moveFrom, legalMoves, game, pendingPromotion]);

  // Board colors matching our theme
  const lightSquareStyle: React.CSSProperties = { backgroundColor: '#e8dcc8' };
  const darkSquareStyle: React.CSSProperties = { backgroundColor: '#7d945d' };

  // Get promotion dialog position based on target square
  const getPromotionDialogStyle = (): React.CSSProperties => {
    if (!pendingPromotion) return {};

    const file = pendingPromotion.to.charCodeAt(0) - 'a'.charCodeAt(0); // 0-7
    const rank = parseInt(pendingPromotion.to[1]) - 1; // 0-7

    // Calculate position (each square is 60px = 480px / 8)
    const squareSize = 60;
    let left = file * squareSize;
    let top: number;

    // Flip coordinates if board is flipped
    if (boardConfig.flipped) {
      left = (7 - file) * squareSize;
      top = rank * squareSize;
    } else {
      top = (7 - rank) * squareSize;
    }

    // Adjust to center the dialog on the square
    // Dialog is ~240px wide (4 pieces * 60px), so offset by half
    left = Math.max(0, Math.min(left - 90, 480 - 240));

    return {
      left: `${left}px`,
      top: `${top}px`,
    };
  };

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

      {/* Promotion dialog */}
      {pendingPromotion && (
        <>
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40 z-20 rounded-lg"
            onClick={handlePromotionCancel}
          />

          {/* Promotion piece selector */}
          <div
            className="absolute z-30 flex gap-1 p-2 glass-panel rounded-lg shadow-2xl"
            style={getPromotionDialogStyle()}
          >
            {PROMOTION_PIECES.map(({ piece, symbol, name }) => (
              <button
                key={piece}
                onClick={() => handlePromotionSelect(piece)}
                className="w-14 h-14 flex items-center justify-center text-4xl hover:bg-(--accent-primary)/30 rounded-lg transition-colors"
                style={{
                  color: currentTurn === 'white' ? '#fff' : '#333',
                  textShadow:
                    currentTurn === 'white'
                      ? '0 1px 2px rgba(0,0,0,0.8)'
                      : '0 1px 2px rgba(255,255,255,0.5)',
                }}
                title={name}
              >
                {symbol}
              </button>
            ))}
          </div>
        </>
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
            allowDragging: isHumanTurn() && !isThinking && !pendingPromotion,
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
