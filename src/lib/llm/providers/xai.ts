import type {
  LLMProvider,
  LLMConfig,
  LLMRequestConfig,
  LLMResponse,
  LLMModel,
} from '../../../types';
import { extractMoveFromResponse } from '../prompt';

const XAI_MODELS: LLMModel[] = [
  // Newer generation (best-effort IDs; availability depends on your xAI account access)
  { id: 'grok-3', name: 'Grok 3', providerId: 'xai' },
  { id: 'grok-3-mini', name: 'Grok 3 Mini', providerId: 'xai' },
  { id: 'grok-2', name: 'Grok 2', providerId: 'xai' },
  { id: 'grok-2-mini', name: 'Grok 2 Mini', providerId: 'xai' },
];

export const xaiProvider: LLMProvider = {
  id: 'xai',
  name: 'xAI (Grok)',
  models: XAI_MODELS,

  buildRequest(prompt: string, config: LLMConfig): LLMRequestConfig {
    const modelId = config.customModelSlug?.trim() || config.modelId;

    return {
      url: 'https://api.x.ai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: {
        model: modelId,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: config.temperature,
      },
    };
  },

  parseResponse(responseJson: unknown): LLMResponse {
    const response = responseJson as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
      error?: {
        message?: string;
        type?: string;
      };
    };

    if (response.error) {
      throw new Error(`xAI API Error: ${response.error.message || 'Unknown error'}`);
    }

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('No content in xAI response');
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
