import type { AiProvider, ModelDescriptor } from "@neurochess/contracts";

export function setupModels(provider: AiProvider): ModelDescriptor[] {
  return [
    {
      provider,
      id: "fixture/model-a",
      name: "Model A (test fixture)",
      capabilities: {
        moveGeneration: "supported",
        parameters: {
          temperature: { min: 0, max: 2 },
          reasoningEffort: { values: ["low", "high"] },
          maxOutputTokens: { min: 16, max: 4096 },
        },
      },
    },
    {
      provider,
      id: "fixture/unknown",
      name: "Unknown model (test fixture)",
      capabilities: {
        moveGeneration: "unknown",
        parameters: { temperature: null, reasoningEffort: null, maxOutputTokens: null },
      },
    },
    {
      provider,
      id: "fixture/unsupported",
      name: "Unsupported model (test fixture)",
      capabilities: {
        moveGeneration: "unsupported",
        parameters: { temperature: null, reasoningEffort: null, maxOutputTokens: null },
      },
    },
    {
      provider,
      id: "fixture/long-" + "identifier".repeat(20),
      name: "Long test model with an independently configured experimental reasoning profile",
      capabilities: {
        moveGeneration: "supported",
        parameters: {
          temperature: null,
          reasoningEffort: null,
          maxOutputTokens: { min: 16, max: 4096 },
        },
      },
    },
  ];
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
