import { PROVIDER_KEY } from "./providers/adapter-contract.js";
import { runProviderIntegrationContract } from "./providers/integration-contract.js";
import { openAiCatalog, openAiFixture, openAiResponse } from "./providers/openai-fixtures.js";

runProviderIntegrationContract({
  wire: openAiFixture,
  catalog: () => Response.json(openAiCatalog()),
  selectedParameters: { temperature: 0.2, reasoningEffort: "high", maxOutputTokens: 128 },
  effectiveParameters: { temperature: 0.2, maxOutputTokens: 128 },
  black: {
    modelId: "gpt-6-astra",
    parameters: { temperature: 1, reasoningEffort: "low", maxOutputTokens: 256 },
    effectiveParameters: { reasoningEffort: "low", maxOutputTokens: 256 },
  },
  defaultParameters: { temperature: 0.2, reasoningEffort: "high", maxOutputTokens: 128 },
  defaultEffectiveParameters: { temperature: 0.2, maxOutputTokens: 128 },
  credentialEcho: () =>
    Response.json({
      ...openAiResponse(JSON.stringify({ move: "e2e4", commentary: `echo ${PROVIDER_KEY}` }), {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
      }),
      id: PROVIDER_KEY,
    }),
  reportedUsage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
  firstInvalid: "malformed_output",
  technicalLoss: {
    responses: () => [
      openAiFixture.failure("refusal"),
      openAiFixture.failure("truncated_output"),
      openAiFixture.failure("malformed_output"),
    ],
    reasons: ["refusal", "truncated_output", "malformed_output"],
  },
  quota: () => openAiFixture.failure("quota"),
});
