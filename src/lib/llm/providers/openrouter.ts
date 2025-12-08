import type {
  LLMProvider,
  LLMConfig,
  LLMRequestConfig,
  LLMResponse,
  LLMModel,
} from '../../../types';
import { extractMoveFromResponse } from '../prompt';

const OPENROUTER_MODELS: LLMModel[] = [
  { id: 'openai/gpt-4o', name: 'GPT-4o', providerId: 'openrouter' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', providerId: 'openrouter' },
  { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo', providerId: 'openrouter' },
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', providerId: 'openrouter' },
  { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus', providerId: 'openrouter' },
  { id: 'anthropic/claude-3-haiku', name: 'Claude 3 Haiku', providerId: 'openrouter' },
  { id: 'google/gemini-pro-1.5', name: 'Gemini Pro 1.5', providerId: 'openrouter' },
  { id: 'google/gemini-flash-1.5', name: 'Gemini Flash 1.5', providerId: 'openrouter' },
  { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B', providerId: 'openrouter' },
  { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B', providerId: 'openrouter' },
  { id: 'mistralai/mistral-large', name: 'Mistral Large', providerId: 'openrouter' },
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', providerId: 'openrouter' },
  { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B', providerId: 'openrouter' },
];

export const openRouterProvider: LLMProvider = {
  id: 'openrouter',
  name: 'OpenRouter',
  models: OPENROUTER_MODELS,

  buildRequest(prompt: string, config: LLMConfig): LLMRequestConfig {
    const modelId = config.customModelSlug?.trim() || config.modelId;

    return {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        'HTTP-Referer': window.location.origin,
        'X-Title': 'NeuroChess Arena',
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
        max_tokens: config.maxTokens,
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
      };
    };

    if (response.error) {
      throw new Error(`OpenRouter API Error: ${response.error.message || 'Unknown error'}`);
    }

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('No content in OpenRouter response');
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
