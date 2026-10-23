import { describe, expect, it } from "vitest";

import { snapshot } from "./helpers.js";
import { PROVIDER_KEY } from "./providers/adapter-contract.js";
import {
  anthropicCatalog,
  anthropicFixture,
  anthropicModel,
  anthropicResponse,
} from "./providers/anthropic-fixtures.js";
import { runProviderIntegrationContract } from "./providers/integration-contract.js";
import {
  createControlledProviderGame,
  records,
  turn,
  withProviderApi,
} from "./providers/integration-helpers.js";

runProviderIntegrationContract({
  wire: anthropicFixture,
  catalog: () => Response.json(anthropicCatalog()),
  selectedParameters: { temperature: 0.2, reasoningEffort: "low", maxOutputTokens: 256 },
  effectiveParameters: { reasoningEffort: "low", maxOutputTokens: 256 },
  black: {
    modelId: anthropicFixture.modelId,
    parameters: {},
    effectiveParameters: { maxOutputTokens: 1024 },
  },
  defaultParameters: {},
  defaultEffectiveParameters: { maxOutputTokens: 1024 },
  credentialEcho: () =>
    Response.json({
      ...anthropicResponse(JSON.stringify({ move: "e2e4", commentary: PROVIDER_KEY }), {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: null,
      }),
      id: PROVIDER_KEY,
    }),
  reportedUsage: { inputTokens: 100, outputTokens: 10, totalTokens: null },
  firstInvalid: "truncated_output",
  technicalLoss: {
    responses: () => [
      anthropicFixture.failure("truncated_output"),
      anthropicFixture.completion('{"move":"e2e5"}'),
      anthropicFixture.failure("refusal"),
    ],
    reasons: ["truncated_output", "illegal_move", "refusal"],
  },
  quota: () => anthropicFixture.failure("quota"),
});

describe("anthropic provider-specific live capabilities", () => {
  it("rejects settings invalidated by fresh discovery before inference or invocation insertion", async () => {
    await withProviderApi(
      anthropicFixture,
      [Response.json({ ...anthropicCatalog(), data: [{ ...anthropicModel(), max_tokens: 100 }] })],
      async ({ api, guest, http }) => {
        const initial = await createControlledProviderGame(api, guest, anthropicFixture, {
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

  it("records the mandatory default for unknown capabilities without adding optional controls", async () => {
    await withProviderApi(
      anthropicFixture,
      [
        Response.json(anthropicCatalog(["future-text-model"])),
        Response.json(anthropicResponse('{"move":"e2e4"}')),
      ],
      async ({ api, guest, http }) => {
        const initial = await createControlledProviderGame(
          api,
          guest,
          anthropicFixture,
          { maxOutputTokens: 9999, reasoningEffort: "max" },
          "future-text-model",
        );
        expect((await turn(api, guest, initial)).statusCode).toBe(200);
        const sent = (await anthropicFixture.readMove(http.requests[1]!)).parameters;
        expect(sent).toEqual({ maxOutputTokens: 1024 });
        expect(
          (await records(api, guest, initial.gameId)).turns[0]!.attempts[0]!.effectiveParameters,
        ).toEqual(sent);
      },
    );
  });
});
