import { createGame } from "@neurochess/chess";
import {
  type AiConfiguration,
  type ModelDescriptor,
  type ModelDiscoveryResult,
  providerErrorKindSchema,
  type SessionCredential,
} from "@neurochess/contracts";
import { describe, expect, it } from "vitest";

import type { AiProviderAdapter, ListModelsInput } from "./adapter.js";
import { buildModelContext } from "./context.js";
import { createScriptedMockProvider } from "./mock.js";
import { createProviderRegistry, ProviderBoundaryError } from "./registry.js";

const model: ModelDescriptor = {
  provider: "openai",
  id: "discovered-model",
  name: "Discovered fixture",
  supportedParameters: { temperature: { min: 0, max: 1 } },
};
const credential: SessionCredential = { provider: "openai", apiKey: "registry-test-key-canary" };
const configuration: AiConfiguration = {
  provider: "openai",
  modelId: model.id,
  parameters: { temperature: 0, reasoningEffort: "high", maxOutputTokens: 100 },
};
function mock() {
  return createScriptedMockProvider({
    descriptor: { id: "openai", name: "Fixture provider" },
    models: [model],
    moves: [{ output: { move: "e2e4" } }],
  });
}

describe("provider registry", () => {
  it("uses defensive guest-scoped discovered metadata and filters before configuration leaves the registry", async () => {
    const registry = createProviderRegistry([{ adapter: mock() }]);
    const discovery = await registry.discover("guest-a", credential);
    expect(discovery).toEqual({ ok: true, value: [model] });
    if (!discovery.ok) throw new Error("Fixture discovery failed");
    discovery.value[0]!.supportedParameters.temperature!.max = 9;
    expect(registry.resolve("guest-a", configuration)).toEqual({
      ...configuration,
      parameters: { temperature: 0 },
    });
    expect(() => registry.resolve("guest-b", configuration)).toThrow("INVALID_REQUEST");
    expect(() =>
      registry.resolve("guest-a", { ...configuration, parameters: { temperature: 2 } }),
    ).toThrow("INVALID_REQUEST");
    expect(() =>
      registry.resolve("guest-a", {
        ...configuration,
        parameters: { apiKey: credential.apiKey },
      } as AiConfiguration),
    ).toThrow("INVALID_REQUEST");
    expect(credential.apiKey).toBe("registry-test-key-canary");
    expect(JSON.stringify(registry)).not.toContain(credential.apiKey);
  });

  it("expires metadata, bounds the cache, and requires discovery again after a process restart", async () => {
    let now = 0;
    const registry = createProviderRegistry([{ adapter: mock() }], () => now);
    await registry.discover("guest", credential);
    now = 300_000;
    expect(() => registry.resolve("guest", configuration)).toThrow("INVALID_REQUEST");
    for (let index = 0; index < 129; index++) await registry.discover(`guest-${index}`, credential);
    expect(() => registry.resolve("guest-0", configuration)).toThrow("INVALID_REQUEST");
    expect(registry.resolve("guest-128", configuration).modelId).toBe(model.id);
    expect(() =>
      createProviderRegistry([{ adapter: mock() }]).resolve("guest-128", configuration),
    ).toThrow("INVALID_REQUEST");
  });

  it.each(providerErrorKindSchema.options)(
    "returns only the classified %s failure and removes stale metadata",
    async (kind) => {
      let fail = false;
      const provider = mock();
      const adapter: AiProviderAdapter = {
        ...provider,
        async listModels(input) {
          return fail ? { ok: false, error: { kind } } : provider.listModels(input);
        },
      };
      const registry = createProviderRegistry([{ adapter }]);
      await registry.discover("guest", credential);
      fail = true;
      expect(await registry.discover("guest", credential)).toEqual({ ok: false, error: { kind } });
      expect(() => registry.resolve("guest", configuration)).toThrow("INVALID_REQUEST");
    },
  );

  it.each([
    { ok: true, value: [model, model] },
    { ok: true, value: [{ ...model, provider: "google" }] },
    { ok: true, value: [{ ...model, apiKey: credential.apiKey }] },
    { ok: true, value: [{ ...model, name: `echo ${credential.apiKey}` }] },
    { ok: true, value: [{ ...model, id: credential.apiKey }] },
    {
      ok: true,
      value: [
        { ...model, supportedParameters: { reasoningEffort: { values: [credential.apiKey] } } },
      ],
    },
    { ok: true, value: [{ ...model, supportedParameters: { temperature: { min: 1, max: 0 } } }] },
    { ok: false, error: { kind: "provider_auth", message: credential.apiKey } },
    { ok: false, error: { kind: "model_invalid", reason: "malformed_output" } },
    { ok: true, value: [], raw: { apiKey: credential.apiKey } },
  ])(
    "rejects malformed or credential-bearing discovery without caching any part (case %#)",
    async (result) => {
      const registry = createProviderRegistry([
        {
          adapter: {
            ...mock(),
            async listModels() {
              return result as ModelDiscoveryResult;
            },
          },
        },
      ]);
      await expect(registry.discover("guest", credential)).rejects.toThrow(ProviderBoundaryError);
      expect(() => registry.resolve("guest", configuration)).toThrow("INVALID_REQUEST");
    },
  );

  it("never shares or memoizes request credentials across concurrent discoveries", async () => {
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const observed: boolean[] = [];
    let count = 0;
    const provider = mock();
    const adapter: AiProviderAdapter = {
      ...provider,
      async listModels(input) {
        const index = count++;
        if (count === 2) entered.resolve();
        await release.promise;
        observed.push(input.apiKey === `separate-request-key-${index}`);
        return provider.listModels(input);
      },
    };
    const registry = createProviderRegistry([{ adapter }]);
    const pending = [0, 1].map((index) =>
      registry.discover(`guest-${index}`, {
        provider: "openai",
        apiKey: `separate-request-key-${index}`,
      }),
    );
    await entered.promise;
    release.resolve();
    await Promise.all(pending);
    expect(observed).toEqual([true, true]);
    expect(count).toBe(2);
  });

  it("does not resurrect an old catalog when a newer overlapping discovery fails", async () => {
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const provider = mock();
    let calls = 0;
    const adapter: AiProviderAdapter = {
      ...provider,
      async listModels(input) {
        if (++calls === 1) {
          entered.resolve();
          await release.promise;
          return provider.listModels(input);
        }
        return { ok: false, error: { kind: "provider_auth" } };
      },
    };
    const registry = createProviderRegistry([{ adapter }]);
    const older = registry.discover("guest", credential);
    await entered.promise;
    expect(await registry.discover("guest", { ...credential, apiKey: "replacement-key" })).toEqual({
      ok: false,
      error: { kind: "provider_auth" },
    });
    release.resolve();
    expect((await older).ok).toBe(true);
    expect(() => registry.resolve("guest", configuration)).toThrow("INVALID_REQUEST");
  });

  it.each(["discovery", "move"] as const)(
    "clears the %s adapter input on cancellation even if the adapter ignores abort",
    async (operation) => {
      const entered = Promise.withResolvers<ListModelsInput>();
      const release = Promise.withResolvers<void>();
      const provider = mock();
      const adapter: AiProviderAdapter = {
        ...provider,
        async listModels(input) {
          entered.resolve(input);
          await release.promise;
          return provider.listModels(input);
        },
        async requestMove(input) {
          entered.resolve(input);
          await release.promise;
          return provider.requestMove(input);
        },
      };
      const registry = createProviderRegistry([{ adapter }]);
      const controller = new AbortController();
      const game = createGame();
      game.start();
      const pending =
        operation === "discovery"
          ? registry.discover("guest", credential, controller.signal)
          : registry.requestMove(credential, {
              configuration: { ...configuration, parameters: {} },
              context: buildModelContext(game, "white"),
              signal: controller.signal,
            });
      const input = await entered.promise;
      expect(input.apiKey === credential.apiKey).toBe(true);
      const rejected = expect(pending).rejects.toThrow(ProviderBoundaryError);
      controller.abort();
      await rejected;
      expect(input.apiKey).toBe("");
      release.resolve();
      expect(() => registry.resolve("guest", configuration)).toThrow("INVALID_REQUEST");
    },
  );

  it("clears successful adapter inputs and never surfaces a provider exception's name, code, or cause", async () => {
    let input: ListModelsInput | undefined;
    const provider = mock();
    const adapter: AiProviderAdapter = {
      ...provider,
      async listModels(request) {
        input = request;
        return provider.listModels(request);
      },
    };
    const registry = createProviderRegistry([{ adapter }]);
    await registry.discover("guest", credential);
    expect(input?.apiKey).toBe("");
    const broken = createProviderRegistry([
      {
        adapter: {
          ...provider,
          async listModels() {
            throw Object.assign(new Error(credential.apiKey), {
              name: credential.apiKey,
              code: credential.apiKey,
              cause: { credential },
            });
          },
        },
      },
    ]);
    try {
      await broken.discover("guest", credential);
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderBoundaryError);
      expect(String(error)).not.toContain(credential.apiKey);
      expect(JSON.stringify(error)).not.toContain(credential.apiKey);
    }
  });
});
