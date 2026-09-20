import type { TokenUsage } from "@neurochess/contracts";

import type { AiChessContext } from "../../src/providers/adapter.js";
import { createGoogleAdapter } from "../../src/providers/google.js";

import { type AdapterContractFixture, PROVIDER_KEY } from "./adapter-contract.js";

export function googleModel(id = "gemini-2.5-flash") {
  return {
    name: `models/${id}`,
    baseModelId: id,
    version: "001",
    displayName: id,
    description: "Sanitized model fixture",
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    supportedGenerationMethods: ["generateContent", "countTokens", "createCachedContent"],
    temperature: 1,
    maxTemperature: 2,
    thinking: true,
    topP: 0.95,
    topK: 64,
  };
}

export function googleCatalog(ids = ["gemini-2.5-flash"], nextPageToken?: string) {
  return {
    models: ids.map((id) =>
      id === "future-text-model" ? { name: `models/${id}`, displayName: id } : googleModel(id),
    ),
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
  };
}

export function googleResponse(text = '{"move":"e7e5"}', usage?: TokenUsage | null) {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        finishReason: "STOP",
        index: 0,
      },
    ],
    modelVersion: "gemini-2.5-flash",
    responseId: "fixture-response",
    ...(usage === undefined
      ? {}
      : {
          usageMetadata:
            usage === null
              ? null
              : {
                  promptTokenCount: usage.inputTokens,
                  candidatesTokenCount: usage.outputTokens,
                  totalTokenCount: usage.totalTokens,
                },
        }),
  };
}

export function googleError(status: number, code: string, invalidKey = false) {
  return Response.json(
    {
      error: {
        code: status,
        status: code,
        message: PROVIDER_KEY,
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            domain: "googleapis.com",
            reason: invalidKey ? "API_KEY_INVALID" : code,
            metadata: { secret: PROVIDER_KEY },
          },
          {
            "@type": "type.googleapis.com/google.rpc.LocalizedMessage",
            locale: "en-US",
            message: PROVIDER_KEY,
          },
        ],
      },
    },
    { status, headers: { "retry-after": "1", "request-id": PROVIDER_KEY } },
  );
}

export const googleFixture: AdapterContractFixture = {
  provider: "google",
  modelId: "gemini-2.5-flash",
  parameters: { temperature: 0.5, maxOutputTokens: 256 },
  capabilities: {
    moveGeneration: "supported",
    parameters: {
      temperature: { min: 0, max: 2 },
      reasoningEffort: null,
      maxOutputTokens: { min: 1, max: 65_536 },
    },
  },
  reportedUsage: { inputTokens: 70, outputTokens: 15, totalTokens: 110 },
  createAdapter: createGoogleAdapter,
  credential: (request) => request.headers.get("x-goog-api-key"),
  catalog: (ids) =>
    ids.length > 1
      ? [
          Response.json(googleCatalog(ids.slice(0, 1), "next-page+/=")),
          Response.json(googleCatalog(ids.slice(1))),
        ]
      : [Response.json(googleCatalog(ids))],
  completion: (text, usage) =>
    Response.json(googleResponse(text, usage), {
      headers: { "request-id": PROVIDER_KEY },
    }),
  failure(scenario) {
    switch (scenario) {
      case "malformed_output":
        return Response.json(googleResponse('{"commentary":"no move"}'));
      case "refusal":
        return Response.json({
          promptFeedback: { blockReason: "SAFETY", blockReasonMessage: PROVIDER_KEY },
        });
      case "truncated_output":
        return Response.json({
          ...googleResponse(),
          candidates: [{ finishReason: "MAX_TOKENS", index: 0 }],
        });
      case "unsupported_model":
        return googleError(404, "NOT_FOUND");
      case "authentication":
        return googleError(400, "INVALID_ARGUMENT", true);
      case "quota":
      case "rate_limit":
        return googleError(429, "RESOURCE_EXHAUSTED");
      case "upstream":
        return googleError(503, "UNAVAILABLE");
      case "malformed_envelope":
        return Response.json({ ...googleResponse(), candidates: "wrong shape" });
      case "malformed_usage":
        return Response.json({ ...googleResponse(), usageMetadata: { promptTokenCount: "70" } });
      case "timeout":
        return googleError(504, "DEADLINE_EXCEEDED");
    }
  },
  async readMove(request) {
    const body = (await request.json()) as {
      systemInstruction: { parts: { text: string }[] };
      contents: { role: string; parts: { text: string }[] }[];
      generationConfig?: { temperature?: number; maxOutputTokens?: number };
    };
    return {
      modelId: new URL(request.url).pathname.split("/").at(-1)!.split(":")[0]!,
      instructions: body.systemInstruction.parts[0]!.text,
      context: JSON.parse(body.contents[0]!.parts[0]!.text) as AiChessContext,
      parameters: body.generationConfig ?? {},
    };
  },
};
