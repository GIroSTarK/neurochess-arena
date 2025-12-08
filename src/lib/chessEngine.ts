import { Chess } from 'chess.js';
import type { Square, PieceSymbol, Color } from 'chess.js';
import type { MaterialBalance, MaterialCount, MoveRecord, PlayerColor } from '../types';

// Piece values for material calculation
const PIECE_VALUES_MAP: Record<PieceSymbol, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

/**
 * Creates a new Chess instance
 */
export function createGame(fen?: string): Chess {
  return fen ? new Chess(fen) : new Chess();
}

/**
 * Converts UCI move format (e.g., "e2e4") to chess.js move object
 */
export function uciToMove(uci: string): {
  from: Square;
  to: Square;
  promotion?: PieceSymbol;
} {
  const from = uci.slice(0, 2) as Square;
  const to = uci.slice(2, 4) as Square;
  const promotion = uci.length === 5 ? (uci[4] as PieceSymbol) : undefined;

  return { from, to, promotion };
}

/**
 * Validates and makes a move on the board
 * Returns the move in SAN notation if successful, null if invalid
 */
export function makeMove(game: Chess, uci: string): MoveRecord | null {
  try {
    const { from, to, promotion } = uciToMove(uci);
    const move = game.move({ from, to, promotion });

    if (!move) {
      return null;
    }

    const color: PlayerColor = move.color === 'w' ? 'white' : 'black';
    const moveNumber = Math.ceil(game.history().length / 2);

    return {
      san: move.san,
      uci: `${move.from}${move.to}${move.promotion || ''}`,
      fen: game.fen(),
      color,
      moveNumber,
    };
  } catch {
    return null;
  }
}

/**
 * Checks if a UCI move is legal
 */
export function isLegalMove(game: Chess, uci: string): boolean {
  try {
    const { from, to, promotion } = uciToMove(uci);
    const legalMoves = game.moves({ verbose: true });

    return legalMoves.some(
      (move) =>
        move.from === from &&
        move.to === to &&
        (promotion ? move.promotion === promotion : !move.promotion)
    );
  } catch {
    return false;
  }
}

/**
 * Gets all legal moves for the current position
 */
export function getLegalMoves(game: Chess): string[] {
  return game
    .moves({ verbose: true })
    .map((move) => `${move.from}${move.to}${move.promotion || ''}`);
}

/**
 * Gets the current turn as PlayerColor
 */
export function getCurrentTurn(game: Chess): PlayerColor {
  return game.turn() === 'w' ? 'white' : 'black';
}

/**
 * Calculates material count for a color
 */
function countMaterial(game: Chess, color: Color): MaterialCount {
  const board = game.board();
  const count: MaterialCount = {
    pawns: 0,
    knights: 0,
    bishops: 0,
    rooks: 0,
    queens: 0,
  };

  for (const row of board) {
    for (const square of row) {
      if (square && square.color === color) {
        switch (square.type) {
          case 'p':
            count.pawns++;
            break;
          case 'n':
            count.knights++;
            break;
          case 'b':
            count.bishops++;
            break;
          case 'r':
            count.rooks++;
            break;
          case 'q':
            count.queens++;
            break;
        }
      }
    }
  }

  return count;
}

/**
 * Calculates total material value
 */
function calculateTotalValue(count: MaterialCount): number {
  return (
    count.pawns * PIECE_VALUES_MAP.p +
    count.knights * PIECE_VALUES_MAP.n +
    count.bishops * PIECE_VALUES_MAP.b +
    count.rooks * PIECE_VALUES_MAP.r +
    count.queens * PIECE_VALUES_MAP.q
  );
}

/**
 * Calculates material balance for both sides
 */
export function getMaterialBalance(game: Chess): MaterialBalance {
  const white = countMaterial(game, 'w');
  const black = countMaterial(game, 'b');
  const whiteTotal = calculateTotalValue(white);
  const blackTotal = calculateTotalValue(black);
  const diff = whiteTotal - blackTotal;

  return {
    white,
    black,
    whiteTotal,
    blackTotal,
    advantage: diff > 0 ? 'white' : diff < 0 ? 'black' : 'equal',
    advantageValue: Math.abs(diff),
  };
}

/**
 * Formats the move history as PGN-style moves
 */
export function formatMoveHistory(moves: MoveRecord[]): string {
  let result = '';
  for (let i = 0; i < moves.length; i++) {
    if (i % 2 === 0) {
      result += `${moves[i].moveNumber}. `;
    }
    result += moves[i].san + ' ';
  }
  return result.trim();
}

/**
 * Gets the game status message
 */
export function getGameStatus(game: Chess): {
  isGameOver: boolean;
  status: string;
  winner?: PlayerColor;
} {
  if (game.isCheckmate()) {
    const winner = game.turn() === 'w' ? 'black' : 'white';
    return {
      isGameOver: true,
      status: `Checkmate! ${winner.charAt(0).toUpperCase() + winner.slice(1)} wins!`,
      winner,
    };
  }

  if (game.isStalemate()) {
    return {
      isGameOver: true,
      status: 'Stalemate! Game is a draw.',
    };
  }

  if (game.isDraw()) {
    if (game.isThreefoldRepetition()) {
      return {
        isGameOver: true,
        status: 'Draw by threefold repetition.',
      };
    }
    if (game.isInsufficientMaterial()) {
      return {
        isGameOver: true,
        status: 'Draw by insufficient material.',
      };
    }
    return {
      isGameOver: true,
      status: 'Draw by fifty-move rule.',
    };
  }

  if (game.isCheck()) {
    const inCheck = game.turn() === 'w' ? 'White' : 'Black';
    return {
      isGameOver: false,
      status: `${inCheck} is in check!`,
    };
  }

  return {
    isGameOver: false,
    status: `${game.turn() === 'w' ? 'White' : 'Black'} to move`,
  };
}

/**
 * Exports the game as PGN
 */
export function exportPGN(game: Chess, whitePlayer: string, blackPlayer: string): string {
  // Set headers
  const date = new Date().toISOString().split('T')[0].replace(/-/g, '.');

  let pgn = `[Event "NeuroChess Arena"]\n`;
  pgn += `[Site "Browser"]\n`;
  pgn += `[Date "${date}"]\n`;
  pgn += `[White "${whitePlayer}"]\n`;
  pgn += `[Black "${blackPlayer}"]\n`;

  const { isGameOver, winner } = getGameStatus(game);
  let result = '*';
  if (isGameOver) {
    if (winner === 'white') result = '1-0';
    else if (winner === 'black') result = '0-1';
    else result = '1/2-1/2';
  }
  pgn += `[Result "${result}"]\n\n`;

  pgn += game.pgn() || '(No moves)';
  if (isGameOver) {
    pgn += ` ${result}`;
  }

  return pgn;
}
