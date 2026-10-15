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

import { RequestRateLimitFailure } from "./failures";
import { apiOrigin, createHttpRequest, validated } from "./http";
import type { AiIdentity } from "./identity";

export class CredentialFailure extends Error {
  constructor(readonly code: CredentialErrorCode | "cancelled" | "RATE_LIMITED") {
    super(code);
  }
}
export function credentialError(error: unknown): CredentialFailure["code"] {
  if (error instanceof RequestRateLimitFailure) return "RATE_LIMITED";
  return error instanceof CredentialFailure ? error.code : "CREDENTIAL_UNAVAILABLE";
}

export function createCredentialApi(
  apiBaseUrl: string,
  identity: AiIdentity,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
) {
  const request = createHttpRequest({
    baseUrl: apiOrigin(apiBaseUrl, () => new CredentialFailure("CREDENTIAL_INVALID_REQUEST")),
    fetch: fetcher,
    signal: identity.signal,
    headers: identity.expectedAccount
      ? { "x-neurochess-expected-account": identity.expectedAccount }
      : {},
    async beforeRequest() {
      if (
        identity.intent !== "account" ||
        !identity.expectedAccount ||
        identity.expectedAccount === "guest"
      ) {
        throw new CredentialFailure("CREDENTIAL_UNAUTHORIZED");
      }
      await identity.verify();
    },
    afterResponse: () => identity.verify(),
    timeoutAfterPreparation: true,
    errors: {
      schema: credentialErrorResponseSchema,
      failure: (kind) =>
        new CredentialFailure(kind === "cancelled" ? "cancelled" : "CREDENTIAL_UNAVAILABLE"),
      isFailure: (error): error is CredentialFailure => error instanceof CredentialFailure,
      fromResponse(error) {
        if (error.code === "CREDENTIAL_UNAUTHORIZED") identity.lost?.();
        return new CredentialFailure(error.code);
      },
    },
  });
  function input<T>(schema: z.ZodType<T>, value: unknown): T {
    return validated(schema, value, () => new CredentialFailure("CREDENTIAL_INVALID_REQUEST"));
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
