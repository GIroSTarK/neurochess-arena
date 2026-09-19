import type { TokenUsage } from "@neurochess/contracts";

import type { AiChessContext } from "../../src/providers/adapter.js";
import { createOpenAiAdapter } from "../../src/providers/openai.js";

import { type AdapterContractFixture, PROVIDER_KEY } from "./adapter-contract.js";

export function openAiCatalog(ids = ["gpt-4.1", "gpt-6-astra"]) {
  return {
    object: "list",
    data: ids.map((id) => ({
      id,
      object: "model",
      created: 1744588800,
      owned_by: "openai",
      shutdown_date: null,
    })),
  };
}

export function openAiResponse(text = '{"move":"e7e5"}', usage?: TokenUsage | null) {
  return {
    id: "resp_fixture",
    object: "response",
    created_at: 1789776000,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: "gpt-4.1-2025-04-14",
    output: [
      {
        id: "msg_fixture",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
      },
    ],
    ...(usage === undefined
      ? {}
      : {
          usage:
            usage === null
              ? null
              : {
                  input_tokens: usage.inputTokens,
                  output_tokens: usage.outputTokens,
                  total_tokens: usage.totalTokens,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 },
                },
        }),
    metadata: {},
    store: false,
  };
}

export const openAiFixture: AdapterContractFixture = {
  provider: "openai",
  modelId: "gpt-4.1",
  parameters: { temperature: 0.2, maxOutputTokens: 128 },
  capabilities: {
    moveGeneration: "supported",
    parameters: {
      temperature: { min: 0, max: 2 },
      reasoningEffort: null,
      maxOutputTokens: { min: 16, max: 32_768 },
    },
  },
  createAdapter: createOpenAiAdapter,
  credential: (request) => request.headers.get("authorization"),
  catalog: (ids) => [Response.json(openAiCatalog(ids))],
  completion: (text, usage) =>
    Response.json(openAiResponse(text, usage), { headers: { "x-request-id": PROVIDER_KEY } }),
  failure(scenario) {
    const error = (status: number, code: string) =>
      Response.json(
        { error: { code, message: PROVIDER_KEY, type: "invalid_request_error", param: null } },
        { status, headers: { "retry-after": "1", "x-request-id": PROVIDER_KEY } },
      );
    switch (scenario) {
      case "malformed_output":
        return Response.json(openAiResponse('{"commentary":"no move"}'));
      case "refusal":
        return Response.json({
          ...openAiResponse(),
          output: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "refusal", refusal: PROVIDER_KEY }],
            },
          ],
        });
      case "truncated_output":
        return Response.json({
          ...openAiResponse('{"move":'),
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        });
      case "unsupported_model":
        return error(404, "model_not_found");
      case "authentication":
        return error(401, "invalid_api_key");
      case "quota":
        return error(429, "insufficient_quota");
      case "rate_limit":
        return error(429, "rate_limit_exceeded");
      case "upstream":
        return error(503, "server_is_overloaded");
      case "malformed_envelope":
        return Response.json({ ...openAiResponse(), output: "wrong shape" });
      case "malformed_usage":
        return Response.json({
          ...openAiResponse(),
          usage: { input_tokens: "70", output_tokens: 10, total_tokens: 80 },
        });
      case "timeout":
        return error(408, "request_timeout");
    }
  },
  async readMove(request) {
    const body = (await request.json()) as {
      model: string;
      instructions: string;
      input: string;
      temperature?: number;
      max_output_tokens?: number;
      reasoning?: { effort: string };
    };
    return {
      modelId: body.model,
      instructions: body.instructions,
      context: JSON.parse(body.input) as AiChessContext,
      parameters: {
        ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
        ...(body.max_output_tokens === undefined
          ? {}
          : { maxOutputTokens: body.max_output_tokens }),
        ...(body.reasoning === undefined ? {} : { reasoningEffort: body.reasoning.effort }),
      },
    };
  },
};
