import type { PlayerColor } from '../../types';

export const CHESS_SYSTEM_PROMPT = `You are a chess engine. Your task is to select the best move from a list of legal moves.

## Response Format
You MUST respond with a JSON block in exactly this format:

\`\`\`json
{
  "move": "UCI_MOVE",
  "explanation": "Brief explanation"
}
\`\`\`

## Rules
- Choose ONE move from the provided legal moves list
- Use UCI format exactly as shown (e.g., "e2e4", "g1f3", "e7e8q")
- Focus on selecting the strategically best move
- Do NOT suggest multiple moves`;

const RECENT_MOVES_CONTEXT = 10;

export function buildChessUserPrompt(
  fen: string,
  _pgn: string,
  currentTurn: PlayerColor,
  moveHistory: string[],
  legalMoves: string[]
): string {
  const colorName = currentTurn === 'white' ? 'White' : 'Black';
  const legalMovesDisplay = legalMoves.join(', ');

  const recentMoves =
    moveHistory.length > RECENT_MOVES_CONTEXT
      ? moveHistory.slice(-RECENT_MOVES_CONTEXT)
      : moveHistory;
  const recentMovesDisplay =
    recentMoves.length > 0
      ? `${moveHistory.length > RECENT_MOVES_CONTEXT ? '... ' : ''}${recentMoves.join(' ')}`
      : '(Opening)';

  return `## Position (FEN)
${fen}

## Recent Moves
${recentMovesDisplay}

## ${colorName} to move

## Legal Moves (${legalMoves.length})
${legalMovesDisplay}

Select the best move.`;
}

export function buildChessPrompt(
  fen: string,
  pgn: string,
  currentTurn: PlayerColor,
  moveHistory: string[],
  legalMoves: string[]
): string {
  return `${CHESS_SYSTEM_PROMPT}

---

${buildChessUserPrompt(fen, pgn, currentTurn, moveHistory, legalMoves)}`;
}

export function extractMoveFromResponse(
  responseText: string
): { move: string; thoughts?: string } | null {
  const jsonMatch = responseText.match(/```json\s*\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.move && typeof parsed.move === 'string') {
        const move = parsed.move.toLowerCase().trim();
        if (isValidUciMove(move)) {
          return {
            move,
            thoughts: parsed.explanation || parsed.thoughts || undefined,
          };
        }
      }
    } catch {
      /* ignore */
    }
  }

  const jsonObjectMatch = responseText.match(
    /\{[^{}]*"move"\s*:\s*"([a-h][1-8][a-h][1-8][qrbn]?)"[^{}]*\}/i
  );
  if (jsonObjectMatch) {
    try {
      const parsed = JSON.parse(jsonObjectMatch[0]);
      const move = parsed.move.toLowerCase().trim();
      if (isValidUciMove(move)) {
        return {
          move,
          thoughts: parsed.explanation || parsed.thoughts || undefined,
        };
      }
    } catch {
      if (jsonObjectMatch[1]) {
        return { move: jsonObjectMatch[1].toLowerCase() };
      }
    }
  }

  const movePropertyMatch = responseText.match(/"move"\s*:\s*"([a-h][1-8][a-h][1-8][qrbn]?)"/i);
  if (movePropertyMatch) {
    return { move: movePropertyMatch[1].toLowerCase() };
  }

  const explicitPhrases = [
    /(?:my (?:final )?move is|i (?:will )?play|best move(?:\s+is)?|i choose|final move:?|move:)\s*[:\s]*\**([a-h][1-8][a-h][1-8][qrbn]?)\**/i,
    /(?:therefore|thus|so),?\s+(?:i (?:will )?play|my move is)\s*[:\s]*\**([a-h][1-8][a-h][1-8][qrbn]?)\**/i,
  ];

  for (const pattern of explicitPhrases) {
    const match = responseText.match(pattern);
    if (match) {
      return { move: match[1].toLowerCase() };
    }
  }

  const allUciMoves = responseText.match(/\b[a-h][1-8][a-h][1-8][qrbn]?\b/gi);
  if (allUciMoves && allUciMoves.length > 0) {
    return { move: allUciMoves[allUciMoves.length - 1].toLowerCase() };
  }

  return null;
}

function isValidUciMove(move: string): boolean {
  return /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move);
}
