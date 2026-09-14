import {
  type AiProvider,
  type ModelDiscoveryResult,
  modelDiscoveryResultSchema,
  type NormalizedMoveResponse,
  normalizedMoveResponseSchema,
} from "@neurochess/contracts";

import type {
  AiProviderAdapter,
  ListModelsInput,
  MoveRequest,
} from "../../src/providers/adapter.js";

type Step<Input, Output> = Output | ((input: Input) => Output | Promise<Output>);

export function createScriptedAdapter(script: {
  provider: AiProvider;
  models?: readonly Step<ListModelsInput, ModelDiscoveryResult>[];
  moves?: readonly Step<MoveRequest, NormalizedMoveResponse>[];
}): AiProviderAdapter & { readonly discoveryCalls: number; readonly moveCalls: number } {
  let discoveryCalls = 0;
  let moveCalls = 0;
  const models = [...(script.models ?? [])];
  const moves = [...(script.moves ?? [])];

  async function run<Input, Output>(step: Step<Input, Output> | undefined, input: Input) {
    if (step === undefined) throw new Error("Scripted adapter exhausted");
    return typeof step === "function"
      ? (step as (input: Input) => Output | Promise<Output>)(input)
      : step;
  }

  return {
    provider: script.provider,
    get discoveryCalls() {
      return discoveryCalls;
    },
    get moveCalls() {
      return moveCalls;
    },
    async listModels(input) {
      return modelDiscoveryResultSchema.parse(await run(models[discoveryCalls++], input));
    },
    async requestMove(input) {
      return normalizedMoveResponseSchema.parse(await run(moves[moveCalls++], input));
    },
  };
}
