import {
  credentialClearRequestSchema,
  credentialDeletedResponseSchema,
  type CredentialErrorCode,
  credentialErrorResponseSchema,
  credentialListResponseSchema,
  credentialMetadataSchema,
  credentialRevokeRequestSchema,
  type CredentialSaveRequest,
  credentialSaveRequestSchema,
} from "@neurochess/contracts";
import type { z } from "zod";

import type { AiIdentity } from "./ai-client";

export class CredentialFailure extends Error {
  constructor(readonly code: CredentialErrorCode | "cancelled") {
    super(code);
  }
}
export function credentialError(error: unknown): CredentialFailure["code"] {
  return error instanceof CredentialFailure ? error.code : "CREDENTIAL_UNAVAILABLE";
}

export function createCredentialApi(
  apiBaseUrl: string,
  identity: AiIdentity,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
) {
  const origin = new URL(apiBaseUrl);
  if (
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && origin.hostname === "localhost")) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  ) {
    throw new CredentialFailure("CREDENTIAL_INVALID_REQUEST");
  }

  function input<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new CredentialFailure("CREDENTIAL_INVALID_REQUEST");
    return parsed.data;
  }
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<T> {
    const abort = new AbortController();
    const combined = AbortSignal.any([signal, identity.signal, abort.signal]);
    const cancelled = () => signal.aborted || identity.signal.aborted;
    const timer = setTimeout(() => abort.abort(), 10_000);
    try {
      if (cancelled()) throw new CredentialFailure("cancelled");
      if (
        identity.intent !== "account" ||
        !identity.expectedAccount ||
        identity.expectedAccount === "guest"
      ) {
        throw new CredentialFailure("CREDENTIAL_UNAUTHORIZED");
      }
      await identity.verify();
      if (cancelled()) throw new CredentialFailure("cancelled");
      const response = await fetcher(new URL(path, origin), {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {
          accept: "application/json",
          "x-neurochess-expected-account": identity.expectedAccount,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combined,
      });
      const payload: unknown = await response.json();
      if (combined.aborted) throw new CredentialFailure("CREDENTIAL_UNAVAILABLE");
      if (!response.ok) {
        const error = credentialErrorResponseSchema.safeParse(payload);
        if (error.success && error.data.code === "CREDENTIAL_UNAUTHORIZED") identity.lost?.();
        throw new CredentialFailure(error.success ? error.data.code : "CREDENTIAL_UNAVAILABLE");
      }
      await identity.verify();
      if (cancelled()) throw new CredentialFailure("cancelled");
      const result = schema.safeParse(payload);
      if (!result.success) throw new CredentialFailure("CREDENTIAL_UNAVAILABLE");
      return result.data;
    } catch (error) {
      if (cancelled()) throw new CredentialFailure("cancelled");
      if (error instanceof CredentialFailure) throw error;
      throw new CredentialFailure("CREDENTIAL_UNAVAILABLE");
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    signal: identity.signal,
    list: (signal: AbortSignal) => request("/credentials", credentialListResponseSchema, signal),
    save: (value: CredentialSaveRequest, signal: AbortSignal) =>
      request(
        "/credentials",
        credentialMetadataSchema,
        signal,
        input(credentialSaveRequestSchema, value),
      ),
    revoke: (credentialId: string, signal: AbortSignal) =>
      request(
        "/credentials/revoke",
        credentialDeletedResponseSchema,
        signal,
        input(credentialRevokeRequestSchema, { credentialId }),
      ),
    clear: (signal: AbortSignal) =>
      request(
        "/credentials/clear",
        credentialDeletedResponseSchema,
        signal,
        input(credentialClearRequestSchema, { confirm: true }),
      ),
  };
}
export type CredentialApi = ReturnType<typeof createCredentialApi>;
