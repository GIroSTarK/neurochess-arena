import { randomUUID } from "node:crypto";

import {
  type AiConfiguration,
  aiConfigurationSchema,
  modelCatalogIdSchema,
  type ModelDescriptor,
  type ModelDiscoveryResponse,
  modelDiscoveryResultSchema,
  modelListSchema,
  normalizedMoveResponseSchema,
  providerDescriptorSchema,
  type ProviderId,
  type SessionCredential,
  sessionCredentialSchema,
} from "@neurochess/contracts";

import { GameRequestError } from "../games/errors.js";

import type { AiProviderAdapter, ListModelsInput, MoveRequest } from "./adapter.js";
import { resolveAiConfiguration } from "./normalization.js";

export interface ProviderRegistration {
  readonly adapter: AiProviderAdapter;
  /** Optional trusted fixtures for server tests; live catalogs come from discovery. */
  readonly models?: readonly ModelDescriptor[];
}

export class ProviderBoundaryError extends Error {
  constructor() {
    super("INVALID_PROVIDER_RESPONSE");
    this.name = "ProviderBoundaryError";
  }
}

const catalogTtlMs = 5 * 60_000;
const maxCatalogs = 128;

export function createProviderRegistry(
  registrations: readonly ProviderRegistration[] = [],
  now: () => number = Date.now,
) {
  const providers = registrations.map(({ adapter, models }) => {
    const descriptor = providerDescriptorSchema.safeParse(adapter.descriptor);
    const catalog = modelListSchema.safeParse(models ?? []);
    if (
      !descriptor.success ||
      !catalog.success ||
      catalog.data.some((model) => model.provider !== descriptor.data.id)
    ) {
      throw new Error("INVALID_AI_CATALOG");
    }
    return { adapter, descriptor: descriptor.data, models: catalog.data };
  });
  if (new Set(providers.map(({ descriptor }) => descriptor.id)).size !== providers.length) {
    throw new Error("INVALID_AI_CATALOG");
  }
  // References select exact catalogs without retaining keys or mixing accounts' capabilities.
  const catalogs = new Map<
    string,
    { scope: string; provider: ProviderId; expiresAt: number; models: ModelDescriptor[] | null }
  >();
  const latest = new Map<string, string>();

  function discard(id: string) {
    const catalog = catalogs.get(id);
    if (!catalog) return;
    const lookup = `${catalog.scope}:${catalog.provider}`;
    if (latest.get(lookup) === id) latest.delete(lookup);
    catalogs.delete(id);
  }

  function prune() {
    for (const [key, catalog] of catalogs) {
      if (catalog.expiresAt <= now()) discard(key);
    }
  }

  function providerFor(id: ProviderId) {
    const provider = providers.find(({ descriptor }) => descriptor.id === id);
    if (!provider) throw new GameRequestError("NOT_FOUND");
    return provider;
  }

  return {
    list: () => ({ providers: providers.map(({ descriptor }) => ({ ...descriptor })) }),
    has: (id: ProviderId) => {
      providerFor(id);
    },
    resolve(scope: string, requested: AiConfiguration, catalogId?: string): AiConfiguration {
      const parsed = aiConfigurationSchema.safeParse(requested);
      if (!parsed.success) throw new GameRequestError("INVALID_REQUEST");
      const provider = providerFor(parsed.data.provider);
      prune();
      const reference = catalogId ?? latest.get(`${scope}:${parsed.data.provider}`);
      const catalog = reference ? catalogs.get(reference) : undefined;
      if (
        catalogId !== undefined &&
        (!modelCatalogIdSchema.safeParse(catalogId).success ||
          catalog?.scope !== scope ||
          catalog.provider !== parsed.data.provider ||
          !catalog.models)
      ) {
        throw new GameRequestError("INVALID_REQUEST");
      }
      const models = catalog?.models ?? provider.models;
      const model = models.find((candidate) => candidate.id === parsed.data.modelId);
      const resolved = model && resolveAiConfiguration(parsed.data, model);
      if (!resolved) throw new GameRequestError("INVALID_REQUEST");
      return resolved;
    },
    async discover(
      scope: string,
      credential: SessionCredential,
      signal?: AbortSignal,
      previousCatalogId?: string,
    ): Promise<ModelDiscoveryResponse> {
      validateCredential(credential);
      const { adapter } = providerFor(credential.provider);
      const input = { apiKey: credential.apiKey, ...(signal ? { signal } : {}) };
      prune();
      if (previousCatalogId !== undefined) {
        const previous = catalogs.get(previousCatalogId);
        if (
          !modelCatalogIdSchema.safeParse(previousCatalogId).success ||
          (previous && (previous.scope !== scope || previous.provider !== credential.provider))
        ) {
          throw new GameRequestError("INVALID_REQUEST");
        }
        // Refresh invalidates only this draft. Expired or evicted references can rediscover.
        discard(previousCatalogId);
      }
      if (catalogs.size >= maxCatalogs) {
        const oldest = catalogs.keys().next();
        if (!oldest.done) discard(oldest.value);
      }
      const cacheId = randomUUID();
      const catalog = {
        scope,
        provider: credential.provider,
        expiresAt: now() + catalogTtlMs,
        models: null as ModelDescriptor[] | null,
      };
      catalogs.set(cacheId, catalog);
      // Callers without a reference retain the latest-request behavior.
      latest.set(`${scope}:${credential.provider}`, cacheId);
      try {
        return await runProviderRequest(input, async () => {
          const parsed = modelDiscoveryResultSchema.safeParse(await adapter.listModels(input));
          if (
            signal?.aborted ||
            !parsed.success ||
            containsCredential(parsed.data, input.apiKey) ||
            (parsed.data.ok &&
              parsed.data.value.some((model) => model.provider !== credential.provider))
          ) {
            throw new ProviderBoundaryError();
          }
          if (parsed.data.ok && catalogs.get(cacheId) === catalog) {
            catalog.models = structuredClone(parsed.data.value);
            catalog.expiresAt = now() + catalogTtlMs;
          }
          return parsed.data.ok ? { ...parsed.data, catalogId: cacheId } : parsed.data;
        });
      } finally {
        if (catalog.models === null && catalogs.get(cacheId) === catalog) discard(cacheId);
      }
    },
    async requestMove(credential: SessionCredential, input: Omit<MoveRequest, "apiKey">) {
      validateCredential(credential);
      const { adapter } = providerFor(input.configuration.provider);
      if (credential.provider !== input.configuration.provider) {
        throw new GameRequestError("INVALID_REQUEST");
      }
      const request = { ...input, apiKey: credential.apiKey };
      return runProviderRequest(request, async () => {
        const parsed = normalizedMoveResponseSchema.safeParse(await adapter.requestMove(request));
        if (
          request.signal?.aborted ||
          !parsed.success ||
          containsCredential(parsed.data, request.apiKey)
        ) {
          throw new ProviderBoundaryError();
        }
        return parsed.data;
      });
    },
  };
}

async function runProviderRequest<T>(
  input: { apiKey: string; signal?: ListModelsInput["signal"] },
  execute: () => Promise<T>,
): Promise<T> {
  const stopped = Promise.withResolvers<never>();
  const abort = () => stopped.reject(new ProviderBoundaryError());
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (input.signal?.aborted) throw new ProviderBoundaryError();
    return await Promise.race([execute(), stopped.promise]);
  } catch {
    // No raw adapter exception, cause, or validation diagnostic may cross this boundary.
    throw new ProviderBoundaryError();
  } finally {
    input.signal?.removeEventListener("abort", abort);
    input.apiKey = "";
  }
}

export function validateCredential(credential: SessionCredential): void {
  if (!sessionCredentialSchema.safeParse(credential).success) {
    throw new GameRequestError("INVALID_REQUEST");
  }
}

function containsCredential(value: unknown, apiKey: string): boolean {
  if (typeof value === "string") return value.includes(apiKey);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, nested]) => key.includes(apiKey) || containsCredential(nested, apiKey),
  );
}
