import type { AiParameters, ModelDiscoveryResult } from "@neurochess/contracts";
import { describe, expect, it } from "vitest";

import { discoverModels, effectiveParameters } from "../../src/providers/discovery.js";

import { createScriptedAdapter } from "./scripted-adapter.js";
import { turnCatalog } from "./turn-catalog.js";

const apiKey = "discovery-secret-sentinel";
const input = () => ({ apiKey, signal: new AbortController().signal });
const model = turnCatalog("openai")[0]!;

describe("request-scoped model discovery", () => {
  it("rejects credential echoes even when JSON would escape the key", async () => {
    const escapedKey = 'key-with-"quote-and-\\slash';
    const adapter = createScriptedAdapter({
      provider: "openai",
      models: [{ ok: true, models: [{ ...model, name: escapedKey }] }],
    });
    expect(await discoverModels(adapter, { ...input(), apiKey: escapedKey })).toEqual({
      ok: false,
      error: { code: "provider_unavailable", reason: "invalid_response" },
    });
  });

  it("returns bounded current catalogs and empty catalogs without caching credentials or results", async () => {
    const adapter = createScriptedAdapter({
      provider: "openai",
      models: [
        { ok: true, models: [model] },
        { ok: true, models: [] },
        { ok: false, error: { code: "provider_auth" } },
      ],
    });
    expect(await discoverModels(adapter, input())).toEqual({ ok: true, models: [model] });
    expect(await discoverModels(adapter, input())).toEqual({ ok: true, models: [] });
    expect(await discoverModels(adapter, input())).toEqual({
      ok: false,
      error: { code: "provider_auth" },
    });
    expect(adapter.discoveryCalls).toBe(3);
    expect(JSON.stringify(adapter)).not.toContain(apiKey);
  });

  it.each([
    { ok: true, models: [{ ...model, provider: "google" }] },
    { ok: true, models: [{ ...model, name: apiKey }] },
    { ok: true, models: [{ ...model, id: apiKey }] },
    {
      ok: true,
      models: [
        {
          ...model,
          capabilities: {
            ...model.capabilities,
            parameters: {
              ...model.capabilities.parameters,
              reasoningEffort: { values: [apiKey] },
            },
          },
        },
      ],
    },
    { ok: true, models: [{ ...model, name: "bad\0name" }] },
    { ok: true, models: [model, model] },
    { ok: true, models: [{ ...model, extra: apiKey }] },
    { ok: false, error: { code: "model_invalid", reason: "malformed_output" } },
    { ok: false, error: { code: "provider_auth", message: apiKey } },
  ])("drops invalid/secret-bearing normalized data without exposing the payload", async (raw) => {
    const result = await discoverModels(
      {
        provider: "openai",
        listModels: async () => raw as ModelDiscoveryResult,
        requestMove: async () => {
          throw new Error("Unused");
        },
      },
      input(),
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "provider_unavailable", reason: "invalid_response" },
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("drops every field of an upstream exception", async () => {
    const adapter = createScriptedAdapter({
      provider: "openai",
      models: [
        () => {
          throw Object.assign(new Error(apiKey, { cause: { apiKey } }), {
            name: apiKey,
            code: apiKey,
          });
        },
      ],
    });
    expect(await discoverModels(adapter, input())).toEqual({
      ok: false,
      error: { code: "provider_unavailable", reason: "upstream" },
    });
  });

  it.each([false, true])(
    "propagates cancellation/timeout without retaining a secret reason",
    async (timeout) => {
      const controller = new AbortController();
      const entered = Promise.withResolvers<void>();
      const adapter = createScriptedAdapter({
        provider: "openai",
        models: [
          ({ signal }) => {
            expect(signal).toBe(controller.signal);
            entered.resolve();
            return new Promise<ModelDiscoveryResult>((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(new Error(apiKey)), { once: true }),
            );
          },
        ],
      });
      const pending = discoverModels(adapter, { apiKey, signal: controller.signal });
      await entered.promise;
      controller.abort(timeout ? new DOMException(apiKey, "TimeoutError") : apiKey);
      expect(await pending).toEqual({
        ok: false,
        error: timeout
          ? { code: "provider_timeout" }
          : { code: "provider_unavailable", reason: "cancelled" },
      });
    },
  );
});

describe("server capability filtering", () => {
  const requested: AiParameters = { temperature: 0, reasoningEffort: "high", maxOutputTokens: 100 };
  it("keeps supported values, including zero", () => {
    expect(effectiveParameters(requested, model.capabilities)).toEqual(requested);
  });
  it("omits unknown parameters and all controls for unknown generation support", () => {
    expect(
      effectiveParameters(requested, { ...model.capabilities, moveGeneration: "unknown" }),
    ).toEqual({});
    expect(
      effectiveParameters(requested, {
        ...model.capabilities,
        parameters: {
          temperature: null,
          reasoningEffort: null,
          maxOutputTokens: model.capabilities.parameters.maxOutputTokens,
        },
      }),
    ).toEqual({ maxOutputTokens: 100 });
  });
  it.each<AiParameters>([
    { temperature: 3 },
    { reasoningEffort: "extreme" },
    { maxOutputTokens: 100_001 },
  ])("rejects values outside a known capability", (parameters) => {
    expect(effectiveParameters(parameters, model.capabilities)).toBeNull();
  });
});
