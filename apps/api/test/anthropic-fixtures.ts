export function anthropicModelInfo(id = "claude-haiku-4-5-20251001") {
  return {
    id,
    type: "model",
    display_name: "Claude Haiku 4.5",
    created_at: "2025-10-01T00:00:00Z",
    max_input_tokens: 200_000,
    max_tokens: 64_000,
    capabilities: {
      effort: {
        supported: false,
        low: { supported: false },
        medium: { supported: false },
        high: { supported: false },
        xhigh: { supported: false },
        max: { supported: false },
      },
      structured_outputs: { supported: true },
      thinking: { supported: true, types: { enabled: { supported: true } } },
    },
  };
}

export function anthropicModels(ids: readonly string[] = [anthropicModelInfo().id]) {
  return {
    data: ids.map((id) => anthropicModelInfo(id)),
    has_more: false,
    first_id: ids[0] ?? null,
    last_id: ids.at(-1) ?? null,
  };
}

export function anthropicMessage(output: unknown = { move: "e2e4" }) {
  return {
    id: "msg_fixture1",
    type: "message",
    role: "assistant",
    model: anthropicModelInfo().id,
    content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }],
    stop_reason: "end_turn",
    stop_sequence: null,
  };
}
