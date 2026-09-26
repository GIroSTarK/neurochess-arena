import {
  credentialAcknowledgementSchema,
  credentialClearRequestSchema,
  type CredentialErrorCode,
  credentialErrorResponseSchema,
  credentialIdParamsSchema,
  credentialListQuerySchema,
  credentialListResponseSchema,
  credentialMetadataSchema,
  credentialRevokeRequestSchema,
  credentialSaveRequestSchema,
  emptyQuerySchema,
} from "@neurochess/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { AuthRequestError } from "../auth/errors.js";
import type { createAccountIdentityResolver } from "../identity/account.js";
import { credentialErrorMessages } from "../locales/en.js";

import { CredentialRequestError, type CredentialService } from "./service.js";

export interface CredentialApiOptions {
  readonly credentials: CredentialService;
  readonly accountIdentity: ReturnType<typeof createAccountIdentityResolver>;
  readonly webOrigin: string;
}
const statuses = {
  CREDENTIAL_UNAUTHORIZED: 401,
  CREDENTIAL_FORBIDDEN: 403,
  CREDENTIAL_INVALID_REQUEST: 400,
  CREDENTIAL_NOT_FOUND: 404,
  CREDENTIAL_STORAGE_DISABLED: 503,
  CREDENTIAL_UNAVAILABLE: 500,
} as const satisfies Record<CredentialErrorCode, number>;
const errors = {
  400: credentialErrorResponseSchema,
  401: credentialErrorResponseSchema,
  403: credentialErrorResponseSchema,
  404: credentialErrorResponseSchema,
  500: credentialErrorResponseSchema,
  503: credentialErrorResponseSchema,
};

export async function registerCredentialRoutes(
  app: FastifyInstance,
  options: CredentialApiOptions,
) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const principalFor = async (request: FastifyRequest) => {
    const principal = await options.accountIdentity(request);
    if (!principal) throw new CredentialRequestError("CREDENTIAL_UNAUTHORIZED");
    return principal;
  };
  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-content-type-options", "nosniff");
    if (
      (request.headers.origin !== undefined && request.headers.origin !== options.webOrigin) ||
      (request.method === "POST" && !request.headers.origin)
    ) {
      throw new CredentialRequestError("CREDENTIAL_FORBIDDEN");
    }
    if (
      request.method === "POST" &&
      request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
    ) {
      throw new CredentialRequestError("CREDENTIAL_INVALID_REQUEST");
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const code: CredentialErrorCode =
      error instanceof CredentialRequestError
        ? error.code
        : error instanceof AuthRequestError && error.statusCode === 401
          ? "CREDENTIAL_UNAUTHORIZED"
          : typeof error === "object" &&
              error !== null &&
              "statusCode" in error &&
              typeof error.statusCode === "number" &&
              error.statusCode >= 400 &&
              error.statusCode < 500
            ? "CREDENTIAL_INVALID_REQUEST"
            : "CREDENTIAL_UNAVAILABLE";
    if (code === "CREDENTIAL_UNAVAILABLE") request.log.error({ code }, "Credential request failed");
    return reply.code(statuses[code]).send(
      credentialErrorResponseSchema.parse({
        code,
        message: credentialErrorMessages[code],
        requestId: request.id,
      }),
    );
  });
  routes.get(
    "/api/credentials",
    {
      schema: {
        querystring: credentialListQuerySchema,
        response: { 200: credentialListResponseSchema, ...errors },
      },
    },
    async (request) => options.credentials.list(await principalFor(request), request.query),
  );
  routes.post(
    "/api/credentials",
    {
      bodyLimit: 16_384,
      schema: {
        body: credentialSaveRequestSchema,
        querystring: emptyQuerySchema,
        response: { 201: credentialMetadataSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(await options.credentials.save(await principalFor(request), request.body)),
  );
  routes.post(
    "/api/credentials/:credentialId/revoke",
    {
      bodyLimit: 1024,
      schema: {
        params: credentialIdParamsSchema,
        body: credentialRevokeRequestSchema,
        querystring: emptyQuerySchema,
        response: { 200: credentialAcknowledgementSchema, ...errors },
      },
    },
    async (request) => {
      await options.credentials.revoke(await principalFor(request), request.params.credentialId);
      return { success: true as const };
    },
  );
  routes.post(
    "/api/credentials/clear",
    {
      bodyLimit: 1024,
      schema: {
        body: credentialClearRequestSchema,
        querystring: emptyQuerySchema,
        response: { 200: credentialAcknowledgementSchema, ...errors },
      },
    },
    async (request) => {
      await options.credentials.clear(await principalFor(request));
      return { success: true as const };
    },
  );
}
