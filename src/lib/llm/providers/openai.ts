import type {
  LLMProvider,
  LLMConfig,
  LLMRequestConfig,
  LLMResponse,
  LLMModel,
} from '../../../types';
import { extractMoveFromResponse } from '../prompt';

const OPENAI_MODELS: LLMModel[] = [
  { id: 'gpt-4o', name: 'GPT-4o', providerId: 'openai' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', providerId: 'openai' },
  { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', providerId: 'openai' },
  { id: 'gpt-4', name: 'GPT-4', providerId: 'openai' },
  { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', providerId: 'openai' },
  { id: 'o1-preview', name: 'O1 Preview', providerId: 'openai' },
  { id: 'o1-mini', name: 'O1 Mini', providerId: 'openai' },
];

export const openAIProvider: LLMProvider = {
  id: 'openai',
  name: 'OpenAI',
  models: OPENAI_MODELS,

  buildRequest(prompt: string, config: LLMConfig): LLMRequestConfig {
    const modelId = config.customModelSlug?.trim() || config.modelId;
    const isO1Model = modelId.startsWith('o1');

    // O1 models don't support temperature
    const body: Record<string, unknown> = {
      model: modelId,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      max_tokens: config.maxTokens,
    };

    if (!isO1Model) {
      body.temperature = config.temperature;
    }

    return {
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body,
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
      throw new Error(`OpenAI API Error: ${response.error.message || 'Unknown error'}`);
    }

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('No content in OpenAI response');
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
