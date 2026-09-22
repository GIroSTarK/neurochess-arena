import { describe, expect, it } from "vitest";

import { snapshot } from "./helpers.js";
import { PROVIDER_KEY } from "./providers/adapter-contract.js";
import { runProviderIntegrationContract } from "./providers/integration-contract.js";
import {
  createProviderGame,
  records,
  turn,
  withProviderApi,
} from "./providers/integration-helpers.js";
import {
  openRouterCatalog,
  openRouterError,
  openRouterFixture,
  openRouterModel,
  openRouterResponse,
} from "./providers/openrouter-fixtures.js";

runProviderIntegrationContract({
  wire: openRouterFixture,
  catalog: () => Response.json(openRouterCatalog()),
  selectedParameters: { temperature: 0.2, reasoningEffort: "low", maxOutputTokens: 256 },
  effectiveParameters: { temperature: 0.2, reasoningEffort: "low", maxOutputTokens: 256 },
  black: { modelId: openRouterFixture.modelId, parameters: {}, effectiveParameters: {} },
  defaultParameters: {},
  defaultEffectiveParameters: {},
  credentialEcho: () =>
    Response.json({
      ...openRouterResponse(JSON.stringify({ move: "e2e4", commentary: PROVIDER_KEY }), {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 140,
      }),
      id: PROVIDER_KEY,
    }),
  reportedUsage: { inputTokens: 100, outputTokens: 10, totalTokens: 140 },
  firstInvalid: "truncated_output",
  technicalLoss: {
    responses: () => [
      openRouterFixture.failure("truncated_output"),
      openRouterFixture.completion('{"move":"e2e5"}'),
      openRouterError(200, 403, { error_type: "refusal", raw: PROVIDER_KEY }),
    ],
    reasons: ["truncated_output", "illegal_move", "refusal"],
  },
  quota: () =>
    openRouterError(200, 429, {
      error_type: "rate_limit_exceeded",
      provider_name: "Upstream",
      raw: PROVIDER_KEY,
    }),
});

describe("openrouter provider-specific live capabilities", () => {
  it("rejects settings invalidated by fresh discovery before inference or invocation insertion", async () => {
    await withProviderApi(
      openRouterFixture,
      [
        Response.json({
          ...openRouterCatalog(),
          data: [{ ...openRouterModel(), top_provider: { max_completion_tokens: 100 } }],
        }),
      ],
      async ({ api, guest, http }) => {
        const initial = await createProviderGame(api, guest, openRouterFixture, {
          maxOutputTokens: 256,
        });
        const response = await turn(api, guest, initial);
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({ code: "AI_PARAMETERS_INVALID" });
        expect((await records(api, guest, initial.gameId)).turns[0]!.attempts).toEqual([]);
        expect((await snapshot(api, guest, initial.gameId)).state).toBe("paused");
        expect(http.transport).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("persists no speculative parameters for unknown capabilities", async () => {
    await withProviderApi(
      openRouterFixture,
      [
        Response.json(openRouterCatalog(["future-text-model"])),
        Response.json(openRouterResponse('{"move":"e2e4"}')),
      ],
      async ({ api, guest, http }) => {
        const initial = await createProviderGame(
          api,
          guest,
          openRouterFixture,
          { maxOutputTokens: 9999, reasoningEffort: "max" },
          "future-text-model",
        );
        expect((await turn(api, guest, initial)).statusCode).toBe(200);
        const sent = (await openRouterFixture.readMove(http.requests[1]!)).parameters;
        expect(sent).toEqual({});
        expect(
          (await records(api, guest, initial.gameId)).turns[0]!.attempts[0]!.effectiveParameters,
        ).toEqual(sent);
      },
    );
  });

  it("pauses models that disappear or no longer advertise text output without inference", async () => {
    for (const catalog of [
      openRouterCatalog([]),
      {
        data: [
          {
            ...openRouterModel(),
            architecture: { input_modalities: ["text"], output_modalities: ["image"] },
          },
        ],
      },
    ]) {
      await withProviderApi(
        openRouterFixture,
        [Response.json(catalog)],
        async ({ api, guest, http }) => {
          const initial = await createProviderGame(api, guest, openRouterFixture);
          const response = await turn(api, guest, initial);
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json()).toMatchObject({ state: "paused", moves: [], result: "*" });
          expect((await records(api, guest, initial.gameId)).turns[0]).toMatchObject({
            invalidOutputCount: 0,
            attempts: [
              {
                outcome: "provider_error",
                error: { code: "provider_unavailable", reason: "unsupported_model" },
                usage: null,
                effectiveParameters: {},
              },
            ],
          });
          expect(http.transport).toHaveBeenCalledTimes(1);
        },
      );
    }
  });
});
