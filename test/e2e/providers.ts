import type { ProviderDescriptor } from "@neurochess/contracts";

import type { AiProviderAdapter } from "../../apps/api/src/providers/adapter";
import { models } from "../ai-models";

import { requestAcceptanceMove } from "./acceptance-providers";

const telemetryAttempts = new Map<string, number>();

export const setupProviders = (
  [
    { id: "openai", name: "OpenAI" },
    { id: "anthropic", name: "Anthropic" },
    { id: "google", name: "Google" },
    { id: "openrouter", name: "OpenRouter" },
  ] satisfies ProviderDescriptor[]
).map((descriptor) => ({
  adapter: {
    descriptor,
    async listModels(input) {
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      if (input.apiKey === "fixture-empty") return { ok: true, value: [] };
      if (input.apiKey === "fixture-auth") return { ok: false, error: { kind: "provider_auth" } };
      if (["fixture-white-disjoint", "fixture-black-disjoint"].includes(input.apiKey)) {
        const color = input.apiKey === "fixture-white-disjoint" ? "white" : "black";
        return {
          ok: true,
          value: [
            {
              provider: descriptor.id,
              id: `${color}-only-model`,
              name: `${color}-only model`,
              supportedParameters: {},
            },
          ],
        };
      }
      return { ok: true, value: models(descriptor.id) };
    },
    async requestMove(input) {
      if (input.apiKey.startsWith("fixture-acceptance:")) {
        return requestAcceptanceMove(descriptor, input);
      }
      const promotion = input.apiKey === "fixture-human-promotion";
      const recovery = input.apiKey.startsWith("fixture-recovery");
      const telemetry = input.apiKey.startsWith("fixture-telemetry-");
      const delay = promotion
        ? 30
        : input.apiKey.endsWith("-slow")
          ? 11_000
          : recovery || telemetry
            ? 400
            : 1_500;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", finish);
          resolve();
        };
        // Setup-only fixtures hold their first turn so creation/recovery assertions remain
        // independent of playback. Every provider operation here is an in-process mock.
        const timer =
          promotion || recovery || telemetry || input.apiKey.startsWith("fixture-playback")
            ? setTimeout(finish, delay)
            : undefined;
        input.signal?.addEventListener("abort", finish, { once: true });
        if (input.signal?.aborted) finish();
      });
      if (input.signal?.aborted) {
        return { ok: false, error: { kind: "provider_unavailable" }, latencyMs: 0, usage: null };
      }
      const script = promotion
        ? ["a2a4", "h7h5", "a4a5", "h5h4", "a5a6", "h4h3", "a6b7", "h3g2", "b7a8n", "g2h1r", "g1f3"]
        : ["f2f3", "e7e5", "g2g4", "d8h4"];
      const ply =
        2 * (Number(input.context.fen.split(" ")[5]) - 1) +
        (input.context.color === "black" ? 1 : 0);
      if (telemetry && ply === 0) {
        const attempt = (telemetryAttempts.get(input.apiKey) ?? 0) + 1;
        telemetryAttempts.set(input.apiKey, attempt);
        if (attempt < 3) {
          return {
            ok: false,
            error:
              attempt === 1
                ? { kind: "model_invalid", reason: "illegal_move" }
                : { kind: "provider_quota" },
            latencyMs: attempt * 10,
            usage: null,
          };
        }
        telemetryAttempts.delete(input.apiKey);
      }
      const move = recovery
        ? ["g1f3", "g8f6", "f3g1", "f6g8"][ply % 4]
        : script.find((move) => input.context.legalMoves.includes(move));
      if (!move) throw new Error("PLAYBACK_FIXTURE_EXHAUSTED");
      if (telemetry) {
        return {
          ok: true,
          value: {
            move,
            ...(ply === 0
              ? { commentary: '<img src=x onerror="alert(1)"> Controls the center.' }
              : {}),
            latencyMs: (ply + 1) * 125,
            usage: ply === 0 ? { inputTokens: 0, outputTokens: 7, totalTokens: null } : null,
          },
        };
      }
      return { ok: true, value: { move, latencyMs: delay, usage: null } };
    },
  } satisfies AiProviderAdapter,
}));
