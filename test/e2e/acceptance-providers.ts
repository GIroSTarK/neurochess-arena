import { setTimeout } from "node:timers/promises";

import type { ProviderDescriptor } from "@neurochess/contracts";

import type { MoveRequest } from "../../apps/api/src/providers/adapter";
import {
  createScriptedMockProvider,
  type MockMoveStep,
  type ScriptedMockProvider,
} from "../../apps/api/src/providers/mock";
import { models } from "../ai-models";

const scripts = new Map<string, ScriptedMockProvider>();

export async function requestAcceptanceMove(descriptor: ProviderDescriptor, input: MoveRequest) {
  const scenario = input.apiKey.split(":")[1];
  if (scenario === "live-retries") {
    await setTimeout(1_800, undefined, { signal: input.signal }).catch(() => undefined);
    if (input.signal?.aborted) {
      return {
        ok: false as const,
        error: { kind: "provider_unavailable" as const },
        latencyMs: 0,
        usage: null,
      };
    }
  }
  if (scenario === "illegal-success") {
    // Even a structurally valid adapter success must pass authoritative chess validation.
    return {
      ok: true as const,
      value: { move: "e2e5", latencyMs: 0, usage: null },
    };
  }
  if (scenario === "provider_auth") {
    return {
      ok: false as const,
      error: { kind: "provider_auth" as const },
      latencyMs: 0,
      usage: null,
    };
  }
  const fixture = `${descriptor.id}:${input.apiKey}`;
  let script = scripts.get(fixture);
  if (!script) {
    const invalid: MockMoveStep[] = [
      { output: "not JSON" },
      { output: { move: "e2e5" } },
      { output: { move: "a1a8" } },
    ];
    const prefix: MockMoveStep[] =
      scenario === "invalid"
        ? invalid
        : scenario === "live-retries"
          ? invalid.slice(0, 2)
          : scenario === "budget"
            ? [invalid[0]!, { error: { kind: "provider_quota" } }, ...invalid.slice(1)]
            : scenario === "provider_quota" ||
                scenario === "provider_timeout" ||
                scenario === "provider_unavailable"
              ? [{ error: { kind: scenario } }]
              : [];
    script = createScriptedMockProvider({
      descriptor,
      models: models(descriptor.id),
      moves: [
        ...prefix,
        ...(input.context.color === "white" ? ["f2f3", "g2g4"] : ["e7e5", "d8h4"]).map((move) => ({
          output: { move },
        })),
      ],
    });
    scripts.set(fixture, script);
  }
  return script.requestMove(input);
}
