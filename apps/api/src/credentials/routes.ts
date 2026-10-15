import {
  credentialClearRequestSchema,
  credentialDeletedResponseSchema,
  type CredentialErrorCode,
  credentialErrorResponseSchema,
  credentialListResponseSchema,
  credentialMetadataSchema,
  credentialRevokeRequestSchema,
  credentialSaveRequestSchema,
  emptyQuerySchema,
  expectedAccountSchema,
} from "@neurochess/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { AccountAuth } from "../auth/service.js";
import { enforcePrincipalLimit, handleRateLimitError } from "../limits/http.js";
import { credentialErrorMessages } from "../locales/en.js";

import { CredentialRequestError, type CredentialService } from "./service.js";

const statuses = {
  CREDENTIAL_INVALID_REQUEST: 400,
  CREDENTIAL_UNAUTHORIZED: 401,
  CREDENTIAL_FORBIDDEN: 403,
  CREDENTIAL_CONFLICT: 409,
  CREDENTIAL_LIMIT_REACHED: 409,
  CREDENTIAL_UNAVAILABLE: 503,
} as const satisfies Record<CredentialErrorCode, number>;

export async function registerCredentialRoutes(
  app: FastifyInstance,
  options: {
    auth: AccountAuth;
    credentials: CredentialService;
    webOrigin: string;
  },
) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    if (request.method === "POST" && request.headers.origin !== options.webOrigin) {
      throw new CredentialRequestError("CREDENTIAL_FORBIDDEN");
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (handleRateLimitError(error, request, reply)) return;
    const code: CredentialErrorCode =
      error instanceof CredentialRequestError
        ? error.code
        : error &&
            typeof error === "object" &&
            "statusCode" in error &&
            typeof error.statusCode === "number" &&
            error.statusCode >= 400 &&
            error.statusCode < 500
          ? "CREDENTIAL_INVALID_REQUEST"
          : "CREDENTIAL_UNAVAILABLE";
    if (code === "CREDENTIAL_UNAVAILABLE") request.log.error("credential_request_failed");
    return reply.code(statuses[code]).send(
      credentialErrorResponseSchema.parse({
        code,
        message: credentialErrorMessages[code],
        requestId: request.id,
      }),
    );
  });
  async function principal(request: FastifyRequest) {
    const expected = expectedAccountSchema.safeParse(
      request.headers["x-neurochess-expected-account"],
    );
    if (!expected.success) throw new CredentialRequestError("CREDENTIAL_INVALID_REQUEST");
    const value = await options.auth.resolve(
      new Headers(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
    );
    if (!value || (expected.data !== undefined && expected.data !== value.userId)) {
      throw new CredentialRequestError("CREDENTIAL_UNAUTHORIZED");
    }
    enforcePrincipalLimit(request, value);
    return value;
  }
  const errors = {
    400: credentialErrorResponseSchema,
    401: credentialErrorResponseSchema,
    403: credentialErrorResponseSchema,
    409: credentialErrorResponseSchema,
    503: credentialErrorResponseSchema,
  };
  routes.get(
    "/credentials",
    {
      schema: {
        querystring: emptyQuerySchema,
        response: { 200: credentialListResponseSchema, ...errors },
      },
    },
    async (request) => options.credentials.list(await principal(request)),
  );
  routes.post(
    "/credentials",
    {
      bodyLimit: 16384,
      schema: {
        querystring: emptyQuerySchema,
        body: credentialSaveRequestSchema,
        response: { 201: credentialMetadataSchema, ...errors },
      },
    },
    async (request, reply) =>
      reply.code(201).send(await options.credentials.save(await principal(request), request.body)),
  );
  for (const [path, body, action] of [
    ["/credentials/revoke", credentialRevokeRequestSchema, "revoke"],
    ["/credentials/clear", credentialClearRequestSchema, "clear"],
  ] as const) {
    routes.post(
      path,
      {
        bodyLimit: 1024,
        schema: {
          querystring: emptyQuerySchema,
          body,
          response: { 200: credentialDeletedResponseSchema, ...errors },
        },
      },
      async (request) => options.credentials[action](await principal(request), request.body),
    );
  }
}
