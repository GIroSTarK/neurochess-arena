export function googleModelInfo(name = "models/gemini-2.5-flash") {
  return {
    name,
    displayName: "Gemini 2.5 Flash",
    supportedGenerationMethods: ["generateContent", "countTokens"],
    inputTokenLimit: 1_048_576,
    outputTokenLimit: 65_536,
    temperature: 1,
    maxTemperature: 2,
    thinking: true,
  };
}

export function googleModels(names: readonly string[] = [googleModelInfo().name]) {
  return { models: names.map((name) => googleModelInfo(name)) };
}

export function googleResponse(output: unknown = { move: "e2e4" }) {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: typeof output === "string" ? output : JSON.stringify(output) }],
        },
        finishReason: "STOP",
      },
    ],
  };
}
