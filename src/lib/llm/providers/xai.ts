import type {
  LLMProvider,
  LLMConfig,
  LLMRequestConfig,
  LLMResponse,
  LLMModel,
  ChessPrompt,
} from '../../../types';
import { extractMoveFromResponse } from '../prompt';

const XAI_MODELS: LLMModel[] = [
  // Newer generation (best-effort IDs; availability depends on your xAI account access)
  { id: 'grok-4-1-fast-reasoning', name: 'Grok 4.1 Fast Reasoning', providerId: 'xai' },
  { id: 'grok-4-fast-reasoning', name: 'Grok 4 Fast Reasoning', providerId: 'xai' },
  { id: 'grok-4-0709', name: 'Grok 4', providerId: 'xai' },
  { id: 'grok-3', name: 'Grok 3', providerId: 'xai' },
  { id: 'grok-3-mini', name: 'Grok 3 Mini', providerId: 'xai' },
];

export const xaiProvider: LLMProvider = {
  id: 'xai',
  name: 'xAI',
  models: XAI_MODELS,

  buildRequest(prompt: ChessPrompt, config: LLMConfig): LLMRequestConfig {
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
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
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
