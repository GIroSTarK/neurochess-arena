import type { PlayerColor } from '../../types';

/**
 * Builds a chess move prompt for LLM
 * Returns a structured prompt that asks the model to return a move in UCI format
 */
export function buildChessPrompt(
  fen: string,
  pgn: string,
  currentTurn: PlayerColor,
  moveHistory: string[]
): string {
  const colorName = currentTurn === 'white' ? 'White' : 'Black';
  const movesDisplay =
    moveHistory.length > 0 ? moveHistory.join(' ') : '(Game just started, no moves yet)';

  return `You are a chess engine. Your task is to find the best legal chess move for the current position.

## Current Position (FEN)
${fen}

## Game History (PGN)
${pgn || '(No moves yet)'}

## Move History
${movesDisplay}

## Your Color
You are playing as ${colorName}. It is ${colorName}'s turn to move.

## Rules for Your Response
1. Analyze the position carefully
2. Choose the best legal move
3. Return your move in UCI format (e.g., "e2e4", "g1f3", "e7e8q" for promotion)
4. Your response MUST contain a JSON block with exactly this format:

\`\`\`json
{
  "move": "YOUR_UCI_MOVE_HERE",
  "explanation": "Brief explanation of why this move is good"
}
\`\`\`

## Important
- The move MUST be in UCI format: source square + destination square (e.g., "e2e4")
- For pawn promotion, add the piece letter at the end (e.g., "e7e8q" for queen)
- Only legal moves will be accepted
- Do NOT suggest multiple moves - only ONE move

Think step by step, then provide your move in the JSON format above.`;
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
