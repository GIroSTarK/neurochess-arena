import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import {
  healthResponseSchema,
  readinessResponseSchema,
  type SafeErrorResponse,
  safeErrorResponseSchema,
} from "@neurochess/contracts";
import Fastify, { type FastifyServerOptions } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { type AuthRoutesOptions, registerAuthRoutes } from "./auth/routes.js";
import { type GameApiOptions, registerGameRoutes } from "./games/routes.js";
import { createAccountIdentityResolver } from "./identity/account.js";

export interface ReadinessProbe {
  check(): Promise<void>;
}

export interface BuildAppOptions {
  readonly logger?: FastifyServerOptions["logger"];
  readonly readiness: ReadinessProbe;
  readonly webOrigin: string;
  readonly gameApi?: Omit<GameApiOptions, "webOrigin">;
  readonly authApi?: Omit<AuthRoutesOptions, "webOrigin">;
}

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({ logger: options.logger ?? false });
  const routes = app.withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);

  await app.register(cors, {
    methods: ["GET", "HEAD", "OPTIONS", "POST"],
    credentials: true,
    origin(origin, callback) {
      callback(null, origin === options.webOrigin);
    },
  });

  routes.get(
    "/health",
    {
      schema: {
        response: { 200: healthResponseSchema },
      },
    },
    async () => ({ status: "ok" as const }),
  );

  routes.get(
    "/ready",
    {
      schema: {
        response: {
          200: readinessResponseSchema,
          503: readinessResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        await options.readiness.check();
        return { status: "ready" as const };
      } catch (error: unknown) {
        request.log.warn({ err: error }, "Database readiness check failed");
        return reply.code(503).send({ status: "not_ready" as const });
      }
    },
  );

  if (options.gameApi) {
    await app.register(registerGameRoutes, {
      ...options.gameApi,
      ...(options.authApi
        ? { accountIdentity: createAccountIdentityResolver(options.authApi.auth) }
        : {}),
      webOrigin: options.webOrigin,
    });
  }
  if (options.authApi) {
    await app.register(registerAuthRoutes, { ...options.authApi, webOrigin: options.webOrigin });
  }

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send(
      safeError({
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
        requestId: request.id,
      }),
    );
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, "Request failed");

    const statusCode = errorStatusCode(error);

    return reply.code(statusCode).send(
      safeError({
        code: statusCode === 500 ? "INTERNAL_SERVER_ERROR" : "REQUEST_REJECTED",
        message:
          statusCode === 500
            ? "The server could not complete the request."
            : "The request could not be accepted.",
        requestId: request.id,
      }),
    );
  });

  return app;
}

function safeError(input: { code: string; message: string; requestId: string }): SafeErrorResponse {
  return safeErrorResponseSchema.parse(input);
}

function errorStatusCode(error: unknown): number {
  if (error === null || typeof error !== "object" || !("statusCode" in error)) {
    return 500;
  }

  const { statusCode } = error;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
}
