import type {
  LLMProvider,
  LLMConfig,
  LLMRequestConfig,
  LLMResponse,
  LLMModel,
  ChessPrompt,
} from '../../../types';
import { extractMoveFromResponse } from '../prompt';

const OPENROUTER_MODELS: LLMModel[] = [
  { id: 'openai/gpt-5.2', name: 'GPT-5.2', providerId: 'openrouter' },
  { id: 'openai/gpt-5.1', name: 'GPT-5.1', providerId: 'openrouter' },
  { id: 'openai/gpt-5', name: 'GPT-5', providerId: 'openrouter' },
  { id: 'openai/o3', name: 'O3', providerId: 'openrouter' },
  { id: 'openai/o1', name: 'O1', providerId: 'openrouter' },
  { id: 'openai/o1-mini', name: 'O1 Mini', providerId: 'openrouter' },
  { id: 'openai/gpt-4.1', name: 'GPT-4.1', providerId: 'openrouter' },
  { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 Mini', providerId: 'openrouter' },
  { id: 'openai/gpt-4o', name: 'GPT-4o', providerId: 'openrouter' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', providerId: 'openrouter' },
  { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo', providerId: 'openrouter' },
  { id: 'anthropic/claude-4.5-opus', name: 'Claude 4.5 Opus', providerId: 'openrouter' },
  { id: 'anthropic/claude-4.5-sonnet', name: 'Claude 4.5 Sonnet', providerId: 'openrouter' },
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', providerId: 'openrouter' },
  { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus', providerId: 'openrouter' },
  { id: 'anthropic/claude-3-haiku', name: 'Claude 3 Haiku', providerId: 'openrouter' },
  { id: 'google/gemini-2.0-flash', name: 'Gemini 2.0 Flash', providerId: 'openrouter' },
  { id: 'google/gemini-2.0-pro', name: 'Gemini 2.0 Pro', providerId: 'openrouter' },
  { id: 'google/gemini-pro-1.5', name: 'Gemini 1.5 Pro', providerId: 'openrouter' },
  { id: 'google/gemini-flash-1.5', name: 'Gemini 1.5 Flash', providerId: 'openrouter' },
  { id: 'google/gemma-2-9b-it', name: 'Gemma 2 9B IT', providerId: 'openrouter' },
  { id: 'google/gemma-2-27b-it', name: 'Gemma 2 27B IT', providerId: 'openrouter' },
  { id: 'x-ai/grok-3', name: 'Grok 3', providerId: 'openrouter' },
  { id: 'x-ai/grok-3-mini', name: 'Grok 3 Mini', providerId: 'openrouter' },
  { id: 'x-ai/grok-2', name: 'Grok 2', providerId: 'openrouter' },
  { id: 'x-ai/grok-2-mini', name: 'Grok 2 Mini', providerId: 'openrouter' },
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

  buildRequest(prompt: ChessPrompt, config: LLMConfig): LLMRequestConfig {
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
