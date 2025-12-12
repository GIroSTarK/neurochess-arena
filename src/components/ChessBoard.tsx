import { Chessboard } from 'react-chessboard';
import { useGameStore } from '../store/gameStore';
import { getLegalMovesFromSquare } from '../lib/chessEngine';
import { useState, useMemo, useCallback, useEffect } from 'react';

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

  useEffect(() => {
    setMoveFrom(null);
    setPendingPromotion(null);
  }, [status]);

  const isHumanTurn = useCallback(() => {
    if (status !== 'playing') return false;
    const currentPlayer = currentTurn === 'white' ? whitePlayer : blackPlayer;
    return currentPlayer.type === 'human';
  }, [status, currentTurn, whitePlayer, blackPlayer]);

  const isPromotionMove = useCallback(
    (from: string, to: string): boolean => {
      const piece = game.get(from as Parameters<typeof game.get>[0]);
      if (!piece || piece.type !== 'p') return false;

      if (to[1] !== '8' && to[1] !== '1') return false;

      const moves = game.moves({ square: from as Parameters<typeof game.get>[0], verbose: true });
      return moves.some((move) => move.to === to && move.promotion);
    },
    [game]
  );

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

  const handlePromotionCancel = useCallback(() => {
    setPendingPromotion(null);
  }, []);

  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean => {
      if (!isHumanTurn() || isThinking || !targetSquare) {
        return false;
      }

      if (isPromotionMove(sourceSquare, targetSquare)) {
        setPendingPromotion({ from: sourceSquare, to: targetSquare });
        return true;
      }

      const uci = `${sourceSquare}${targetSquare}`;
      return makeHumanMove(uci);
    },
    [isHumanTurn, isThinking, makeHumanMove, isPromotionMove]
  );

  const onSquareClick = useCallback(
    ({ piece, square }: SquareHandlerArgs) => {
      if (!isHumanTurn() || isThinking || pendingPromotion) {
        return;
      }

      const isOwnPiece =
        piece &&
        ((currentTurn === 'white' && piece.pieceType[0] === 'w') ||
          (currentTurn === 'black' && piece.pieceType[0] === 'b'));

      if (moveFrom) {
        if (square === moveFrom) {
          setMoveFrom(null);
          return;
        }

        if (isOwnPiece) {
          setMoveFrom(square);
          return;
        }

        if (isPromotionMove(moveFrom, square)) {
          setPendingPromotion({ from: moveFrom, to: square });
          return;
        }

        const uci = `${moveFrom}${square}`;
        makeHumanMove(uci);
        setMoveFrom(null);
      } else {
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

  const canDragPiece = useCallback(
    ({ piece }: PieceHandlerArgs): boolean => {
      if (!isHumanTurn() || isThinking || pendingPromotion) return false;

      const pieceColor = piece.pieceType[0] === 'w' ? 'white' : 'black';
      return pieceColor === currentTurn;
    },
    [isHumanTurn, isThinking, currentTurn, pendingPromotion]
  );

  const legalMoves = useMemo(() => {
    if (!moveFrom) return [];
    return getLegalMovesFromSquare(game, moveFrom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveFrom, fen]);

  const squareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};

    if (moveFrom) {
      styles[moveFrom] = {
        backgroundColor: 'rgba(124, 92, 255, 0.4)',
      };
    }

    if (pendingPromotion) {
      styles[pendingPromotion.from] = {
        backgroundColor: 'rgba(124, 92, 255, 0.4)',
      };
      styles[pendingPromotion.to] = {
        backgroundColor: 'rgba(124, 92, 255, 0.6)',
      };
    }

    legalMoves.forEach((targetSquare) => {
      const pieceOnSquare = game.get(targetSquare as Parameters<typeof game.get>[0]);

      if (pieceOnSquare) {
        styles[targetSquare] = {
          ...styles[targetSquare],
          boxShadow: 'inset 0 0 0 4px rgba(124, 92, 255, 0.6)',
          borderRadius: '50%',
        };
      } else {
        styles[targetSquare] = {
          ...styles[targetSquare],
          background: `radial-gradient(circle, rgba(124, 92, 255, 0.5) 20%, transparent 20%)`,
        };
      }
    });

    return styles;
  }, [moveFrom, legalMoves, game, pendingPromotion]);

  const BOARD_SIZE = 560;
  const SQUARE_SIZE = BOARD_SIZE / 8;

  const lightSquareStyle: React.CSSProperties = { backgroundColor: '#e8dcc8' };
  const darkSquareStyle: React.CSSProperties = { backgroundColor: '#7d945d' };

  const getPromotionDialogStyle = (): React.CSSProperties => {
    if (!pendingPromotion) return {};

    const file = pendingPromotion.to.charCodeAt(0) - 'a'.charCodeAt(0);
    const rank = parseInt(pendingPromotion.to[1]) - 1;

    let left = file * SQUARE_SIZE;
    let top: number;

    if (boardConfig.flipped) {
      left = (7 - file) * SQUARE_SIZE;
      top = rank * SQUARE_SIZE;
    } else {
      top = (7 - rank) * SQUARE_SIZE;
    }

    const dialogWidth = 280;
    left = Math.max(
      0,
      Math.min(left - (dialogWidth / 2 - SQUARE_SIZE / 2), BOARD_SIZE - dialogWidth)
    );

    return {
      left: `${left}px`,
      top: `${top}px`,
    };
  };

  return (
    <div className="relative">
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

      {pendingPromotion && (
        <>
          <div
            className="absolute inset-0 bg-black/40 z-20 rounded-lg"
            onClick={handlePromotionCancel}
          />

          <div
            className="absolute z-30 flex gap-1 p-2 glass-panel rounded-lg shadow-2xl"
            style={getPromotionDialogStyle()}
          >
            {PROMOTION_PIECES.map(({ piece, symbol, name }) => (
              <button
                key={piece}
                onClick={() => handlePromotionSelect(piece)}
                className="w-[70px] h-[70px] flex items-center justify-center text-5xl hover:bg-(--accent-primary)/30 rounded-lg transition-colors cursor-pointer"
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

      <div
        className="rounded-lg overflow-hidden shadow-2xl glow-accent"
        style={{ width: `${BOARD_SIZE}px`, height: `${BOARD_SIZE}px` }}
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
