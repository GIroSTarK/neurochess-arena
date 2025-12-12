import type {
  LLMProvider,
  LLMConfig,
  LLMRequestConfig,
  LLMResponse,
  LLMModel,
} from '../../../types';
import { extractMoveFromResponse } from '../prompt';

const GOOGLE_MODELS: LLMModel[] = [
  // Gemini
  { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', providerId: 'google' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', providerId: 'google' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', providerId: 'google' },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', providerId: 'google' },

  // Gemma (best-effort IDs; availability may vary by API/product)
  { id: 'gemma-3-12b-it', name: 'Gemma 3 12B', providerId: 'google' },
  { id: 'gemma-3-27b-it', name: 'Gemma 3 27B IT', providerId: 'google' },
];

export const googleProvider: LLMProvider = {
  id: 'google',
  name: 'Google',
  models: GOOGLE_MODELS,

  buildRequest(prompt: string, config: LLMConfig): LLMRequestConfig {
    const modelId = config.customModelSlug?.trim() || config.modelId;

    // Google Generative Language API uses an API key in the query string for browser-friendly usage.
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent` +
      `?key=${encodeURIComponent(config.apiKey)}`;

    return {
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: {
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: config.temperature,
        },
      },
    };
  },

  parseResponse(responseJson: unknown): LLMResponse {
    const response = responseJson as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
      error?: {
        message?: string;
        status?: string;
      };
    };

    if (response.error) {
      throw new Error(
        `Google API Error: ${response.error.message || response.error.status || 'Unknown error'}`
      );
    }

    const parts = response.candidates?.[0]?.content?.parts;
    const content =
      parts
        ?.map((p) => p.text)
        .filter(Boolean)
        .join('') || '';

    if (!content) {
      throw new Error('No text content in Google response');
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
