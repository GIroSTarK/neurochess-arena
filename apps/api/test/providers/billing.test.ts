import { describe, expect, it } from "vitest";

import { calculateCost, pinPricing } from "../../src/pricing/calculator.js";

import { contractInput } from "./adapter-contract.js";
import { anthropicFixture, anthropicResponse } from "./anthropic-fixtures.js";
import { googleFixture, googleResponse } from "./google-fixtures.js";
import { mockHttp } from "./mock-http.js";
import { openAiFixture, openAiResponse } from "./openai-fixtures.js";
import { openRouterFixture, openRouterResponse } from "./openrouter-fixtures.js";

describe("billable usage independent of headline counts and chess output", () => {
  it("subtracts cached OpenAI input once and keeps reasoning inside output", async () => {
    const http = mockHttp([
      Response.json({
        ...openAiResponse(),
        model: "gpt-5-mini-2025-08-07",
        service_tier: "default",
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          input_tokens_details: { cached_tokens: 30 },
          output_tokens_details: { reasoning_tokens: 25 },
        },
      }),
    ]);
    const result = await openAiFixture.createAdapter(http.transport).requestMove({
      ...contractInput(openAiFixture),
      modelId: "gpt-5-mini-2025-08-07",
      parameters: {},
    });
    expect(result).toMatchObject({
      ok: true,
      usage: { inputTokens: 100, outputTokens: 40, totalTokens: null },
      billing: {
        status: "reported",
        provider: "openai",
        pricingMatch: "standard",
        dimensions: {
          inputTokens: 70,
          cachedInputTokens: 30,
          outputTokens: 40,
          reasoningTokens: 25,
        },
      },
    });
  });

  it("keeps Anthropic ordinary input, cache reads and both write TTLs disjoint", async () => {
    const http = mockHttp([
      Response.json({
        ...anthropicResponse(),
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 70,
          cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 30 },
          service_tier: "standard",
          inference_geo: "global",
        },
      }),
    ]);
    const result = await anthropicFixture
      .createAdapter(http.transport)
      .requestMove(contractInput(anthropicFixture));
    expect(result).toMatchObject({
      ok: true,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: null },
      billing: {
        status: "reported",
        dimensions: {
          inputTokens: 10,
          outputTokens: 20,
          cachedInputTokens: 30,
          cacheWrite5mTokens: 40,
          cacheWrite1hTokens: 30,
        },
      },
    });
  });

  it("keeps Google thinking separate from visible output and preserves the reported total", async () => {
    const http = mockHttp([
      Response.json({
        ...googleResponse(),
        modelVersion: "gemini-2.5-flash",
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 40,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 50,
          totalTokenCount: 170,
          serviceTier: "standard",
        },
      }),
    ]);
    const result = await googleFixture
      .createAdapter(http.transport)
      .requestMove(contractInput(googleFixture));
    expect(result).toMatchObject({
      ok: true,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 170 },
      billing: {
        status: "reported",
        pricingMatch: "standard",
        dimensions: {
          inputTokens: 60,
          cachedInputTokens: 40,
          outputTokens: 20,
          reasoningTokens: 50,
        },
      },
    });
  });

  it("normalizes routed cached/write/reasoning details without treating reported cost as pinned pricing", async () => {
    const http = mockHttp([
      Response.json({
        ...openRouterResponse(),
        usage: {
          prompt_tokens: 100,
          completion_tokens: 40,
          total_tokens: 140,
          cost: 0.1,
          prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
          completion_tokens_details: { reasoning_tokens: 25 },
        },
      }),
    ]);
    const result = await openRouterFixture
      .createAdapter(http.transport)
      .requestMove(contractInput(openRouterFixture));
    expect(result).toMatchObject({
      ok: true,
      billing: {
        status: "reported",
        provider: "openrouter",
        pricingMatch: "routing_unknown",
        dimensions: {
          cachedInputTokens: 30,
          cacheWriteTokens: 20,
          outputTokens: 40,
          reasoningTokens: 25,
        },
      },
    });
    expect(result).not.toHaveProperty("billing.cost");
  });

  it("keeps routed billing details on an HTTP error envelope", async () => {
    const http = mockHttp([
      Response.json(
        {
          error: { code: 429 },
          usage: {
            prompt_tokens: 5,
            completion_tokens: 0,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        },
        { status: 429 },
      ),
    ]);
    const result = await openRouterFixture
      .createAdapter(http.transport)
      .requestMove(contractInput(openRouterFixture));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "provider_quota" },
      billing: {
        status: "reported",
        provider: "openrouter",
        dimensions: { cachedInputTokens: 0, outputTokens: 0 },
      },
    });
  });

  it.each([undefined, null, -1, "secret", 101])(
    "never lets bad/missing billing details reject a legal move: %s",
    async (cached) => {
      const http = mockHttp([
        Response.json({
          ...openAiResponse(),
          service_tier: "default",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
            input_tokens_details: { cached_tokens: cached },
          },
        }),
      ]);
      const result = await openAiFixture
        .createAdapter(http.transport)
        .requestMove(contractInput(openAiFixture));
      expect(result.ok).toBe(true);
      expect(result).toHaveProperty("billing");
      expect(JSON.stringify(result)).not.toContain("secret");
    },
  );

  it.each([
    {
      fixture: anthropicFixture,
      raw: { ...anthropicResponse(), usage: { cache_read_input_tokens: "invalid" } },
    },
    {
      fixture: googleFixture,
      raw: { ...googleResponse(), usageMetadata: { thoughtsTokenCount: "invalid" } },
    },
    {
      fixture: googleFixture,
      raw: { ...googleResponse(), usageMetadata: { cachedContentTokenCount: -1 } },
    },
  ])(
    "isolates malformed $fixture.provider supplementary billing metadata from chess",
    async ({ fixture, raw }) => {
      const http = mockHttp([Response.json(raw)]);
      expect(
        await fixture.createAdapter(http.transport).requestMove(contractInput(fixture)),
      ).toMatchObject({
        ok: true,
        billing: { status: "unavailable", reason: "usage_invalid" },
      });
    },
  );

  it.each([
    {
      fixture: anthropicFixture,
      raw: {
        ...anthropicResponse(),
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          service_tier: "standard",
        },
      },
      amount: "0.000330000000",
    },
    {
      fixture: googleFixture,
      raw: {
        ...googleResponse(),
        modelVersion: "gemini-2.5-flash",
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 40,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 50,
        },
      },
      amount: "0.000194200000",
    },
  ])(
    "calculates a complete $fixture.provider adapter response with the pinned catalogue",
    async ({ fixture, raw, amount }) => {
      const http = mockHttp([Response.json(raw)]);
      const result = await fixture
        .createAdapter(http.transport)
        .requestMove(contractInput(fixture));
      expect(
        calculateCost(pinPricing(fixture.provider, fixture.modelId), result.billing),
      ).toMatchObject({ status: "estimated", amount });
    },
  );

  it.each([
    {
      name: "missing write TTL",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 5,
        service_tier: "standard",
      },
      reason: "usage_incomplete",
    },
    {
      name: "inconsistent write TTL",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 5,
        cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 2 },
        service_tier: "standard",
      },
      reason: "usage_invalid",
    },
    {
      name: "unknown cache count",
      usage: { input_tokens: 0, output_tokens: 0, service_tier: "standard" },
      reason: "usage_incomplete",
    },
    {
      name: "regional pricing",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        service_tier: "standard",
        inference_geo: "us",
      },
      reason: "unsupported_dimensions",
    },
    {
      name: "billable tool",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        service_tier: "standard",
        server_tool_use: { web_search_requests: 1 },
      },
      reason: "unsupported_dimensions",
    },
    {
      name: "unknown tier",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      reason: "tier_unknown",
    },
  ])("keeps an honest estimate state for $name", async ({ usage, reason }) => {
    const http = mockHttp([Response.json({ ...anthropicResponse(), usage })]);
    const result = await anthropicFixture
      .createAdapter(http.transport)
      .requestMove(contractInput(anthropicFixture));
    expect(result.ok).toBe(true);
    expect(
      calculateCost(pinPricing("anthropic", anthropicFixture.modelId), result.billing),
    ).toEqual({ status: "unavailable", reason });
  });
});
