import type {
  LLMProvider,
  LLMConfig,
  LLMRequestConfig,
  LLMResponse,
  LLMModel,
  ChessPrompt,
} from '../../../types';
import { extractMoveFromResponse } from '../prompt';

const OPENAI_MODELS: LLMModel[] = [
  // Newer generation (best-effort IDs; may depend on your OpenAI account access)
  { id: 'gpt-5.2', name: 'GPT-5.2', providerId: 'openai' },
  { id: 'gpt-5.2-high', name: 'GPT-5.2 High', providerId: 'openai' },
  { id: 'gpt-5.1', name: 'GPT-5.1', providerId: 'openai' },
  { id: 'gpt-5.1-high', name: 'GPT-5.1 High', providerId: 'openai' },
  { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', providerId: 'openai' },
  { id: 'gpt-5.1-codex-high', name: 'GPT-5.1 Codex High', providerId: 'openai' },
  { id: 'gpt-5', name: 'GPT-5', providerId: 'openai' },
  { id: 'gpt-5-high', name: 'GPT-5 High', providerId: 'openai' },
  { id: 'o1', name: 'O1', providerId: 'openai' },
  { id: 'o3', name: 'O3', providerId: 'openai' },
  { id: 'o4-mini', name: 'O4 Mini', providerId: 'openai' },
  { id: 'gpt-4.1', name: 'GPT-4.1', providerId: 'openai' },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', providerId: 'openai' },
  { id: 'gpt-4o', name: 'GPT-4o', providerId: 'openai' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', providerId: 'openai' },
  { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', providerId: 'openai' },
  { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', providerId: 'openai' },
];

export const openAIProvider: LLMProvider = {
  id: 'openai',
  name: 'OpenAI',
  models: OPENAI_MODELS,

  buildRequest(prompt: ChessPrompt, config: LLMConfig): LLMRequestConfig {
    const selectedModelId = config.customModelSlug?.trim() || config.modelId;

    const effortMatch = selectedModelId.match(/^(.*)-(none|minimal|low|medium|high|xhigh)$/);
    const modelId = effortMatch ? effortMatch[1] : selectedModelId;
    const reasoningEffort = effortMatch ? effortMatch[2] : undefined;

    const isOModule = /^o\d/.test(modelId); // o1, o3, o4-mini, ...

    // For reasoning models (o1, o3, etc.), combine system+user into single user message
    // as they have limited system prompt support
    const messages = isOModule
      ? [{ role: 'user', content: `${prompt.system}\n\n---\n\n${prompt.user}` }]
      : [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ];

    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      // Ask OpenAI to enforce a valid JSON object response (when supported by the model).
      // This improves parse reliability for extracting the UCI move.
      response_format: { type: 'json_object' },
    };

    if (reasoningEffort) {
      body.reasoning_effort = reasoningEffort;
    }

    if (!isOModule) {
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
