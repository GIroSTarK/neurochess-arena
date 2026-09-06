import { createGame } from "@neurochess/chess";
import {
  type AiTelemetry,
  modelDiscoveryResultSchema,
  normalizedMoveResponseSchema,
  providerErrorKindSchema,
  type ProviderId,
} from "@neurochess/contracts";
import { describe, expect, it } from "vitest";

import type { AiProviderAdapter } from "../src/providers/adapter.js";
import { buildModelContext } from "../src/providers/context.js";
import type { MockMoveStep } from "../src/providers/mock.js";

export const contractTelemetry: AiTelemetry = {
  latencyMs: 125.5,
  usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
  providerRequestId: "resp_contract1",
};

export function providerContractTests(options: {
  name: string;
  provider: ProviderId;
  modelId: string;
  telemetry?: AiTelemetry;
  create(steps: readonly MockMoveStep[]): { adapter: AiProviderAdapter; attempts: () => number };
}) {
  describe(`${options.name} shared provider contract`, () => {
    const telemetry = options.telemetry ?? contractTelemetry;
    function fixture(steps: readonly MockMoveStep[]) {
      const game = createGame();
      expect(game.start().ok).toBe(true);
      const before = game.snapshot();
      return {
        ...options.create(steps),
        game,
        before,
        request: {
          apiKey: "contract-key-canary",
          configuration: { provider: options.provider, modelId: options.modelId, parameters: {} },
          context: buildModelContext(game, "white"),
        },
      };
    }

    it("discovers models and returns legal UCI with reported telemetry without changing the game", async () => {
      const { adapter, attempts, request, game, before } = fixture([
        {
          output: { move: "e2e4", commentary: "Controls the center." },
          telemetry,
        },
      ]);
      const discovery = await adapter.listModels({ apiKey: request.apiKey });
      expect(modelDiscoveryResultSchema.parse(discovery)).toEqual(discovery);
      expect(
        discovery.ok &&
          discovery.value.some(
            (model) => model.id === options.modelId && model.provider === options.provider,
          ),
      ).toBe(true);
      expect(attempts()).toBe(0);
      const result = await adapter.requestMove(request);
      expect(result).toEqual({
        ok: true,
        value: { move: "e2e4", commentary: "Controls the center.", ...telemetry },
      });
      expect(normalizedMoveResponseSchema.parse(result)).toEqual(result);
      expect(game.snapshot()).toEqual(before);
      expect(attempts()).toBe(1);
    });

    it.each([undefined, ""])(
      "accepts missing/empty commentary (%j) and unavailable usage",
      async (commentary) => {
        const output = { move: "e2e4", ...(commentary === undefined ? {} : { commentary }) };
        const { adapter, request, attempts } = fixture([{ output }]);
        expect(await adapter.requestMove(request)).toEqual({
          ok: true,
          value: { ...output, latencyMs: 0, usage: null },
        });
        expect(attempts()).toBe(1);
      },
    );

    it.each([
      "not JSON",
      "{",
      '```json\n{"move":"e2e4"}\n```',
      {},
      [],
      null,
      { move: "e4" },
      { move: "resign" },
      { move: "e2e4", commentary: 42 },
      { move: "e2e4", extra: "contract-key-canary" },
    ])("classifies malformed model output in one attempt (%j)", async (output) => {
      const { adapter, request, attempts, game, before } = fixture([{ output, telemetry }]);
      const result = await adapter.requestMove(request);
      expect(result).toEqual({
        ok: false,
        error: { kind: "model_invalid", reason: "malformed_output" },
        ...telemetry,
      });
      expect(normalizedMoveResponseSchema.parse(result)).toEqual(result);
      expect(JSON.stringify(result)).not.toContain(request.apiKey);
      expect(game.snapshot()).toEqual(before);
      expect(attempts()).toBe(1);
    });

    it.each(["e2e5", "e7e5", "e2e4q"])("rejects illegal UCI %s without retries", async (move) => {
      const { adapter, request, attempts } = fixture([{ output: { move } }]);
      expect(await adapter.requestMove(request)).toEqual({
        ok: false,
        error: { kind: "model_invalid", reason: "illegal_move" },
        latencyMs: 0,
        usage: null,
      });
      expect(attempts()).toBe(1);
    });

    it.each(providerErrorKindSchema.options)(
      "keeps %s distinct from model-invalid output",
      async (kind) => {
        const { adapter, request, attempts, game, before } = fixture([{ error: { kind } }]);
        const result = await adapter.requestMove(request);
        expect(result).toEqual({ ok: false, error: { kind }, latencyMs: 0, usage: null });
        expect(normalizedMoveResponseSchema.parse(result)).toEqual(result);
        expect(game.snapshot()).toEqual(before);
        expect(attempts()).toBe(1);
      },
    );
  });
}
