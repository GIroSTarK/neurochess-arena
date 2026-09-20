import type { TokenUsage } from "@neurochess/contracts";

import type { AiChessContext } from "../../src/providers/adapter.js";
import { createOpenRouterAdapter } from "../../src/providers/openrouter.js";

import { type AdapterContractFixture, PROVIDER_KEY } from "./adapter-contract.js";

export function openRouterModel(id = "anthropic/claude-sonnet-4") {
  return {
    id,
    name: id,
    canonical_slug: id,
    created: 1747684800,
    architecture: {
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      tokenizer: "Claude",
    },
    supported_parameters: ["temperature", "max_tokens", "reasoning", "tools"],
    top_provider: { context_length: 200_000, max_completion_tokens: 64_000, is_moderated: true },
    reasoning: {
      mandatory: false,
      supported_efforts: ["high", "medium", "low"],
      default_effort: "medium",
    },
    pricing: { prompt: "0.000003", completion: "0.000015" },
  };
}
export function openRouterCatalog(
  ids = ["anthropic/claude-sonnet-4"],
  total = ids.length,
  next: string | null = null,
) {
  return {
    data: ids.map((id) => (id === "future-text-model" ? { id, name: id } : openRouterModel(id))),
    total_count: total,
    links: { next },
  };
}
export function openRouterResponse(text = '{"move":"e7e5"}', usage?: TokenUsage | null) {
  return {
    id: "gen-fixture",
    object: "chat.completion",
    created: 1747684800,
    model: "anthropic/claude-sonnet-4",
    provider: "Anthropic",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        native_finish_reason: "end_turn",
        message: { role: "assistant", content: text, refusal: null },
      },
    ],
    ...(usage === undefined
      ? {}
      : {
          usage:
            usage === null
              ? null
              : {
                  prompt_tokens: usage.inputTokens,
                  completion_tokens: usage.outputTokens,
                  total_tokens: usage.totalTokens,
                },
        }),
  };
}
export function openRouterError(status: number, code = status, metadata?: object) {
  return Response.json(
    { error: { code, message: PROVIDER_KEY, ...(metadata === undefined ? {} : { metadata }) } },
    { status, headers: { "retry-after": "1", "x-request-id": PROVIDER_KEY } },
  );
}

export const openRouterFixture: AdapterContractFixture = {
  provider: "openrouter",
  modelId: "anthropic/claude-sonnet-4",
  parameters: { temperature: 0.5, reasoningEffort: "low", maxOutputTokens: 256 },
  capabilities: {
    moveGeneration: "supported",
    parameters: {
      temperature: { min: 0, max: 2 },
      reasoningEffort: { values: ["high", "medium", "low"] },
      maxOutputTokens: { min: 1, max: 64_000 },
    },
  },
  reportedUsage: { inputTokens: 70, outputTokens: 15, totalTokens: 85 },
  createAdapter: createOpenRouterAdapter,
  credential: (request) => request.headers.get("authorization"),
  catalog: (ids) =>
    ids.length > 1
      ? [
          Response.json(
            openRouterCatalog(ids.slice(0, 1), ids.length, "/api/v1/models?offset=1&limit=1000"),
          ),
          Response.json(openRouterCatalog(ids.slice(1), ids.length)),
        ]
      : [Response.json(openRouterCatalog(ids))],
  completion: (text, usage) =>
    Response.json(openRouterResponse(text, usage), { headers: { "x-request-id": PROVIDER_KEY } }),
  failure(scenario) {
    switch (scenario) {
      case "malformed_output":
        return Response.json(openRouterResponse('{"commentary":"no move"}'));
      case "refusal": {
        const response = openRouterResponse();
        return Response.json({
          ...response,
          choices: [
            {
              ...response.choices[0],
              finish_reason: "content_filter",
              message: { role: "assistant", content: null, refusal: PROVIDER_KEY },
            },
          ],
        });
      }
      case "truncated_output": {
        const response = openRouterResponse();
        return Response.json({
          ...response,
          choices: [{ ...response.choices[0], finish_reason: "length" }],
        });
      }
      case "unsupported_model":
        return openRouterError(404);
      case "authentication":
        return openRouterError(401);
      case "quota":
        return openRouterError(402);
      case "rate_limit":
        return openRouterError(429);
      case "upstream":
        return openRouterError(502, 502, { provider_name: "Fixture upstream", raw: PROVIDER_KEY });
      case "malformed_envelope":
        return Response.json({ ...openRouterResponse(), choices: "wrong shape" });
      case "malformed_usage":
        return Response.json({ ...openRouterResponse(), usage: { prompt_tokens: "70" } });
      case "timeout":
        return openRouterError(408);
    }
  },
  async readMove(request) {
    const body = (await request.json()) as {
      model: string;
      messages: { role: string; content: string }[];
      temperature?: number;
      max_tokens?: number;
      reasoning?: { effort: string };
    };
    return {
      modelId: body.model,
      instructions: body.messages[0]!.content,
      context: JSON.parse(body.messages[1]!.content) as AiChessContext,
      parameters: {
        ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
        ...(body.max_tokens === undefined ? {} : { maxOutputTokens: body.max_tokens }),
        ...(body.reasoning === undefined ? {} : { reasoningEffort: body.reasoning.effort }),
      },
    };
  },
};
