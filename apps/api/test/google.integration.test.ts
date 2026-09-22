import { describe, expect, it } from "vitest";

import { snapshot } from "./helpers.js";
import { PROVIDER_KEY } from "./providers/adapter-contract.js";
import {
  googleCatalog,
  googleFixture,
  googleModel,
  googleResponse,
} from "./providers/google-fixtures.js";
import { runProviderIntegrationContract } from "./providers/integration-contract.js";
import {
  createProviderGame,
  records,
  turn,
  withProviderApi,
} from "./providers/integration-helpers.js";

runProviderIntegrationContract({
  wire: googleFixture,
  catalog: () => Response.json(googleCatalog()),
  selectedParameters: { temperature: 0.2, reasoningEffort: "low", maxOutputTokens: 256 },
  effectiveParameters: { temperature: 0.2, maxOutputTokens: 256 },
  black: { modelId: googleFixture.modelId, parameters: {}, effectiveParameters: {} },
  defaultParameters: {},
  defaultEffectiveParameters: {},
  credentialEcho: () =>
    Response.json({
      ...googleResponse(JSON.stringify({ move: "e2e4", commentary: PROVIDER_KEY }), {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 140,
      }),
      responseId: PROVIDER_KEY,
    }),
  reportedUsage: { inputTokens: 100, outputTokens: 10, totalTokens: 140 },
  firstInvalid: "truncated_output",
  technicalLoss: {
    responses: () => [
      googleFixture.failure("truncated_output"),
      googleFixture.completion('{"move":"e2e5"}'),
      googleFixture.failure("refusal"),
    ],
    reasons: ["truncated_output", "illegal_move", "refusal"],
  },
  quota: () => googleFixture.failure("quota"),
});

describe("google provider-specific live capabilities", () => {
  it("rejects settings invalidated by fresh discovery before inference or invocation insertion", async () => {
    await withProviderApi(
      googleFixture,
      [
        Response.json({
          ...googleCatalog(),
          models: [{ ...googleModel(), outputTokenLimit: 100 }],
        }),
      ],
      async ({ api, guest, http }) => {
        const initial = await createProviderGame(api, guest, googleFixture, {
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
      googleFixture,
      [
        Response.json(googleCatalog(["future-text-model"])),
        Response.json(googleResponse('{"move":"e2e4"}')),
      ],
      async ({ api, guest, http }) => {
        const initial = await createProviderGame(
          api,
          guest,
          googleFixture,
          { maxOutputTokens: 9999, reasoningEffort: "max" },
          "future-text-model",
        );
        expect((await turn(api, guest, initial)).statusCode).toBe(200);
        const sent = (await googleFixture.readMove(http.requests[1]!)).parameters;
        expect(sent).toEqual({});
        expect(
          (await records(api, guest, initial.gameId)).turns[0]!.attempts[0]!.effectiveParameters,
        ).toEqual(sent);
      },
    );
  });

  it("pauses models that disappear or no longer advertise generateContent without inference", async () => {
    for (const catalog of [
      googleCatalog([]),
      { models: [{ ...googleModel(), supportedGenerationMethods: ["embedContent"] }] },
    ]) {
      await withProviderApi(
        googleFixture,
        [Response.json(catalog)],
        async ({ api, guest, http }) => {
          const initial = await createProviderGame(api, guest, googleFixture);
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
