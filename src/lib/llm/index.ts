import type {
  LLMProvider,
  LLMConfig,
  LLMResponse,
  ProviderId,
  PlayerColor,
  DebugEntry,
} from '../../types';
import { openRouterProvider } from './providers/openrouter';
import { openAIProvider } from './providers/openai';
import { anthropicProvider } from './providers/anthropic';
import { buildChessPrompt } from './prompt';

// Registry of all available providers
const providers: Record<ProviderId, LLMProvider> = {
  openrouter: openRouterProvider,
  openai: openAIProvider,
  anthropic: anthropicProvider,
};

/**
 * Get a provider by ID
 */
export function getProvider(providerId: ProviderId): LLMProvider {
  const provider = providers[providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  return provider;
}

/**
 * Get all available providers
 */
export function getAllProviders(): LLMProvider[] {
  return Object.values(providers);
}

/**
 * Request a move from an LLM
 * Handles retries and error handling
 */
export async function requestLLMMove(
  config: LLMConfig,
  fen: string,
  pgn: string,
  currentTurn: PlayerColor,
  moveHistory: string[],
  onDebug?: (entry: DebugEntry) => void
): Promise<LLMResponse> {
  const provider = getProvider(config.providerId);
  const prompt = buildChessPrompt(fen, pgn, currentTurn, moveHistory);

  // Log the prompt if debug is enabled
  if (onDebug) {
    onDebug({
      timestamp: new Date(),
      type: 'prompt',
      player: currentTurn,
      content: prompt,
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

      // Log the response if debug is enabled
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

      // Log the error if debug is enabled
      if (onDebug) {
        onDebug({
          timestamp: new Date(),
          type: 'error',
          player: currentTurn,
          content: `Attempt ${attempt}/${config.maxRetries}: ${lastError.message}`,
        });
      }

      // Don't retry if it's the last attempt
      if (attempt === config.maxRetries) {
        break;
      }

      // Wait before retrying (exponential backoff)
      await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 500));
    }
  }

  throw lastError || new Error('Failed to get move from LLM');
}

// Re-export for convenience
export { buildChessPrompt } from './prompt';
export type { LLMProvider };
