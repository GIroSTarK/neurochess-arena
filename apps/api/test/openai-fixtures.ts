export function openAiModels(ids: readonly string[] = ["gpt-4.1"]) {
  return {
    object: "list",
    data: ids.map((id) => ({ id, object: "model", created: 1_700_000_000, owned_by: "openai" })),
  };
}

export function openAiResponse(output: unknown = { move: "e2e4" }) {
  return {
    object: "response",
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: typeof output === "string" ? output : JSON.stringify(output),
          },
        ],
      },
    ],
  };
}
