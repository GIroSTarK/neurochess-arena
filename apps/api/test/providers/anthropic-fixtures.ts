import type { TokenUsage } from "@neurochess/contracts";

import type { AiChessContext } from "../../src/providers/adapter.js";
import { createAnthropicAdapter } from "../../src/providers/anthropic.js";

import { type AdapterContractFixture, PROVIDER_KEY } from "./adapter-contract.js";

export function anthropicModel(id = "claude-sonnet-4-6") {
  return {
    type: "model",
    id,
    display_name: id,
    created_at: "2026-02-17T00:00:00Z",
    max_input_tokens: 1_000_000,
    max_tokens: 64_000,
    capabilities: {
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        xhigh: { supported: false },
        max: { supported: true },
      },
      thinking: {
        supported: true,
        types: {
          adaptive: { supported: true },
          enabled: { supported: true },
        },
      },
      structured_outputs: { supported: true },
    },
  };
}

export function anthropicCatalog(ids = ["claude-sonnet-4-6"], hasMore = false) {
  return {
    data: ids.map((id) =>
      id === "future-text-model"
        ? {
            ...anthropicModel(id),
            max_tokens: null,
            capabilities: null,
          }
        : anthropicModel(id),
    ),
    first_id: ids[0] ?? null,
    last_id: ids.at(-1) ?? null,
    has_more: hasMore,
  };
}

export function anthropicResponse(text = '{"move":"e7e5"}', usage?: TokenUsage | null) {
  return {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text, citations: [] }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    ...(usage === undefined
      ? {}
      : {
          usage:
            usage === null
              ? null
              : {
                  input_tokens: usage.inputTokens,
                  output_tokens: usage.outputTokens,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                  service_tier: "standard",
                },
        }),
  };
}

export function anthropicError(status: number, type: string) {
  return Response.json(
    {
      type: "error",
      error: { type, message: PROVIDER_KEY },
      request_id: PROVIDER_KEY,
    },
    { status, headers: { "retry-after": "1", "request-id": PROVIDER_KEY } },
  );
}

export const anthropicFixture: AdapterContractFixture = {
  provider: "anthropic",
  modelId: "claude-sonnet-4-6",
  parameters: { reasoningEffort: "low", maxOutputTokens: 256 },
  capabilities: {
    moveGeneration: "supported",
    parameters: {
      temperature: null,
      reasoningEffort: { values: ["low", "medium", "high", "max"] },
      maxOutputTokens: { min: 1, max: 64_000 },
    },
  },
  reportedUsage: { inputTokens: 70, outputTokens: 15, totalTokens: null },
  createAdapter: createAnthropicAdapter,
  credential: (request) => request.headers.get("x-api-key"),
  catalog: (ids) =>
    ids.length > 1
      ? [
          Response.json(anthropicCatalog(ids.slice(0, 1), true)),
          Response.json(anthropicCatalog(ids.slice(1))),
        ]
      : [Response.json(anthropicCatalog(ids))],
  completion: (text, usage) =>
    Response.json(anthropicResponse(text, usage), {
      headers: { "request-id": PROVIDER_KEY },
    }),
  failure(scenario) {
    switch (scenario) {
      case "malformed_output":
        return Response.json(anthropicResponse('{"commentary":"no move"}'));
      case "refusal":
        return Response.json({ ...anthropicResponse(PROVIDER_KEY), stop_reason: "refusal" });
      case "truncated_output":
        return Response.json({ ...anthropicResponse('{"move":'), stop_reason: "max_tokens" });
      case "unsupported_model":
        return anthropicError(404, "not_found_error");
      case "authentication":
        return anthropicError(401, "authentication_error");
      case "quota":
        return anthropicError(402, "billing_error");
      case "rate_limit":
        return anthropicError(429, "rate_limit_error");
      case "upstream":
        return anthropicError(529, "overloaded_error");
      case "malformed_envelope":
        return Response.json({ ...anthropicResponse(), content: "wrong shape" });
      case "malformed_usage":
        return Response.json({ ...anthropicResponse(), usage: { input_tokens: "70" } });
      case "timeout":
        return anthropicError(504, "timeout_error");
    }
  },
  async readMove(request) {
    const body = (await request.json()) as {
      model: string;
      system: string;
      messages: { role: string; content: string }[];
      max_tokens: number;
      output_config?: { effort: string };
    };
    return {
      modelId: body.model,
      instructions: body.system,
      context: JSON.parse(body.messages[0]!.content) as AiChessContext,
      parameters: {
        maxOutputTokens: body.max_tokens,
        ...(body.output_config === undefined ? {} : { reasoningEffort: body.output_config.effort }),
      },
    };
  },
};
