import type {
  LLMProvider,
  LLMConfig,
  LLMResponse,
  ProviderId,
  PlayerColor,
  DebugEntry,
  ChessPrompt,
} from '../../types';
import { openRouterProvider } from './providers/openrouter';
import { openAIProvider } from './providers/openai';
import { anthropicProvider } from './providers/anthropic';
import { googleProvider } from './providers/google';
import { xaiProvider } from './providers/xai';
import { CHESS_SYSTEM_PROMPT, buildChessUserPrompt } from './prompt';

const providers: Record<ProviderId, LLMProvider> = {
  openrouter: openRouterProvider,
  openai: openAIProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
  xai: xaiProvider,
};

export function getProvider(providerId: ProviderId): LLMProvider {
  const provider = providers[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  return provider;
}

export function getAllProviders(): LLMProvider[] {
  return Object.values(providers);
}

export async function requestLLMMove(
  config: LLMConfig,
  fen: string,
  pgn: string,
  currentTurn: PlayerColor,
  moveHistory: string[],
  legalMoves: string[],
  onDebug?: (entry: DebugEntry) => void
): Promise<LLMResponse> {
  const provider = getProvider(config.providerId);
  const prompt: ChessPrompt = {
    system: CHESS_SYSTEM_PROMPT,
    user: buildChessUserPrompt(fen, pgn, currentTurn, moveHistory, legalMoves),
  };

  if (onDebug) {
    onDebug({
      timestamp: new Date(),
      type: 'prompt',
      player: currentTurn,
      content: `[System]\n${prompt.system}\n\n[User]\n${prompt.user}`,
    });
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      const requestConfig = provider.buildRequest(prompt, config);

      const response = await fetch(requestConfig.url, {
        method: requestConfig.method,
        headers: requestConfig.headers,
        body: JSON.stringify(requestConfig.body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `HTTP ${response.status}: ${response.statusText}`;

        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
        } catch {
          if (errorText) {
            errorMessage = errorText.substring(0, 200);
          }
        }

        throw new Error(errorMessage);
      }

      const responseJson = await response.json();
      const result = provider.parseResponse(responseJson);

      if (onDebug) {
        onDebug({
          timestamp: new Date(),
          type: 'response',
          player: currentTurn,
          content: `Move: ${result.move}${result.thoughts ? `\nThoughts: ${result.thoughts}` : ''}`,
          raw: result.rawResponse,
        });
      }

      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (onDebug) {
        onDebug({
          timestamp: new Date(),
          type: 'error',
          player: currentTurn,
          content: `Attempt ${attempt}/${config.maxRetries}: ${lastError.message}`,
        });
      }

      if (attempt === config.maxRetries) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 500));
    }
  }

  throw lastError || new Error('Failed to get move from LLM');
}

export { CHESS_SYSTEM_PROMPT, buildChessUserPrompt, buildChessPrompt } from './prompt';
export type { LLMProvider };
