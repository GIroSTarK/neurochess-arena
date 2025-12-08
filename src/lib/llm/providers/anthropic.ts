import type {
  LLMProvider,
  LLMConfig,
  LLMRequestConfig,
  LLMResponse,
  LLMModel,
} from '../../../types';
import { extractMoveFromResponse } from '../prompt';

const ANTHROPIC_MODELS: LLMModel[] = [
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', providerId: 'anthropic' },
  { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', providerId: 'anthropic' },
  { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', providerId: 'anthropic' },
  { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku', providerId: 'anthropic' },
];

export const anthropicProvider: LLMProvider = {
  id: 'anthropic',
  name: 'Anthropic',
  models: ANTHROPIC_MODELS,

  buildRequest(prompt: string, config: LLMConfig): LLMRequestConfig {
    const modelId = config.customModelSlug?.trim() || config.modelId;

    return {
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: {
        model: modelId,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      },
    };
  },

  parseResponse(responseJson: unknown): LLMResponse {
    const response = responseJson as {
      content?: Array<{
        type: string;
        text?: string;
      }>;
      error?: {
        message?: string;
        type?: string;
      };
    };

    if (response.error) {
      throw new Error(`Anthropic API Error: ${response.error.message || 'Unknown error'}`);
    }

    const textBlock = response.content?.find((block) => block.type === 'text');
    const content = textBlock?.text;

    if (!content) {
      throw new Error('No text content in Anthropic response');
    }

    const extracted = extractMoveFromResponse(content);
    if (!extracted) {
      throw new Error(`Could not extract move from response: ${content.substring(0, 200)}`);
    }

    return {
      move: extracted.move,
      thoughts: extracted.thoughts,
      rawResponse: content,
    };
  },
};
