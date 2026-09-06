export function openRouterModelInfo(id = "example/chess-model:free") {
  return {
    id,
    name: "Example chess model",
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    supported_parameters: [
      "temperature",
      "max_tokens",
      "response_format",
      "structured_outputs",
      "reasoning",
    ],
    top_provider: { max_completion_tokens: 8192 },
    reasoning: { supported_efforts: ["high", "medium", "low"], mandatory: true },
  };
}

export function openRouterModels() {
  return { data: [openRouterModelInfo()] };
}

export function openRouterResponse(output: unknown = { move: "e2e4" }) {
  return {
    choices: [
      {
        finish_reason: "stop",
        index: 0,
        message: {
          role: "assistant",
          content: typeof output === "string" ? output : JSON.stringify(output),
        },
      },
    ],
  };
}
