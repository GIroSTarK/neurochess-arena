import {
  credentialAcknowledgementSchema,
  credentialClearRequestSchema,
  type CredentialErrorCode,
  credentialErrorResponseSchema,
  credentialIdParamsSchema,
  credentialListQuerySchema,
  credentialListResponseSchema,
  credentialMetadataSchema,
  credentialSaveRequestSchema,
} from "@neurochess/contracts";
import type { z } from "zod";

export class CredentialFailure extends Error {
  constructor(readonly code: CredentialErrorCode | "NETWORK") {
    super(code);
  }
}

function validated<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new CredentialFailure("CREDENTIAL_INVALID_REQUEST");
  return result.data;
}

export function createCredentialApi(baseUrl: string, fetcher = globalThis.fetch.bind(globalThis)) {
  const origin = new URL(baseUrl);
  if (
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && origin.hostname === "localhost")) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new CredentialFailure("CREDENTIAL_INVALID_REQUEST");
  }

  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<T> {
    const cancelled = () => signal.aborted;
    try {
      if (cancelled()) throw new CredentialFailure("NETWORK");
      const response = await fetcher(new URL("/api/credentials" + path, origin), {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      const payload: unknown = await response.json();
      if (cancelled()) throw new CredentialFailure("NETWORK");
      if (!response.ok) {
        const error = credentialErrorResponseSchema.safeParse(payload);
        throw new CredentialFailure(error.success ? error.data.code : "CREDENTIAL_UNAVAILABLE");
      }
      const result = schema.safeParse(payload);
      if (!result.success) throw new CredentialFailure("CREDENTIAL_UNAVAILABLE");
      return result.data;
    } catch (error) {
      if (cancelled()) throw new CredentialFailure("NETWORK");
      if (error instanceof CredentialFailure) throw error;
      throw new CredentialFailure("NETWORK");
    }
  }
  return {
    async list(after: string | null, signal: AbortSignal) {
      const query = validated(credentialListQuerySchema, after ? { after } : {});
      return request(
        query.after ? "?after=" + query.after : "",
        credentialListResponseSchema,
        signal,
      );
    },
    async save(input: unknown, signal: AbortSignal) {
      return request(
        "",
        credentialMetadataSchema,
        signal,
        validated(credentialSaveRequestSchema, input),
      );
    },
    async revoke(credentialId: string, signal: AbortSignal) {
      const params = validated(credentialIdParamsSchema, { credentialId });
      return request(
        "/" + params.credentialId + "/revoke",
        credentialAcknowledgementSchema,
        signal,
        {},
      );
    },
    async clear(signal: AbortSignal) {
      return request(
        "/clear",
        credentialAcknowledgementSchema,
        signal,
        validated(credentialClearRequestSchema, { confirm: true }),
      );
    },
  };
}
export type CredentialApi = ReturnType<typeof createCredentialApi>;
