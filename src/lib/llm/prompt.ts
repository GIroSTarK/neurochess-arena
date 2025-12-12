import type { PlayerColor } from '../../types';

/**
 * System prompt for chess engine role
 * Contains static instructions that don't change between moves
 */
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

/**
 * Builds the user prompt with current game state
 * Contains dynamic information that changes each turn
 */
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

/**
 * Builds a combined prompt for providers that don't support system messages well
 * (e.g., some reasoning models like o1, o3)
 */
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

/**
 * Extracts move from LLM response text
 * Tries multiple patterns to find the UCI move
 * Priority: JSON block > JSON object > "move" property > explicit phrases > last UCI move in text
 */
export function extractMoveFromResponse(
  responseText: string
): { move: string; thoughts?: string } | null {
  // 1. Try to find JSON block first (highest priority)
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
      // JSON parsing failed, try other methods
    }
  }

  // 2. Try to find JSON object without code block
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
      // If JSON parsing failed but we found the move pattern, use regex capture
      if (jsonObjectMatch[1]) {
        return { move: jsonObjectMatch[1].toLowerCase() };
      }
    }
  }

  // 3. Try to find move in "move": "e2e4" format
  const movePropertyMatch = responseText.match(/"move"\s*:\s*"([a-h][1-8][a-h][1-8][qrbn]?)"/i);
  if (movePropertyMatch) {
    return { move: movePropertyMatch[1].toLowerCase() };
  }

  // 4. Try to find move after explicit phrases (more reliable than generic UCI pattern)
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

  // 5. Last resort: find the LAST UCI move mentioned in the text
  // This is more likely to be the final answer rather than analysis of alternatives
  const allUciMoves = responseText.match(/\b[a-h][1-8][a-h][1-8][qrbn]?\b/gi);
  if (allUciMoves && allUciMoves.length > 0) {
    // Return the last match as it's most likely the final decision
    return { move: allUciMoves[allUciMoves.length - 1].toLowerCase() };
  }

  return null;
}
/**
 * Validates if a string is a valid UCI move format
 */
function isValidUciMove(move: string): boolean {
  return /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move);
}
