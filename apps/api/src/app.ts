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

import { registerAuthRoutes } from "./auth/routes.js";
import type { AccountAuth } from "./auth/service.js";
import { registerCredentialRoutes } from "./credentials/routes.js";
import type { CredentialService } from "./credentials/service.js";
import { type GameApiOptions, registerGameRoutes } from "./games/routes.js";
import { registerProfileRoutes } from "./profiles/routes.js";
import type { ProfileService } from "./profiles/service.js";

export interface ReadinessProbe {
  check(): Promise<void>;
}

export interface BuildAppOptions {
  readonly logger?: FastifyServerOptions["logger"];
  readonly readiness: ReadinessProbe;
  readonly webOrigin: string;
  readonly gameApi?: Omit<GameApiOptions, "webOrigin" | "auth">;
  readonly auth?: AccountAuth;
  readonly profiles?: ProfileService;
  readonly credentials?: CredentialService;
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
      webOrigin: options.webOrigin,
      ...(options.auth ? { auth: options.auth } : {}),
    });
  }

  if (options.auth) {
    if (options.credentials) {
      await app.register(registerCredentialRoutes, {
        auth: options.auth,
        credentials: options.credentials,
        webOrigin: options.webOrigin,
      });
    }
    await app.register(registerAuthRoutes, { auth: options.auth, webOrigin: options.webOrigin });
    if (options.profiles) {
      await app.register(registerProfileRoutes, {
        auth: options.auth,
        profiles: options.profiles,
        webOrigin: options.webOrigin,
      });
    }
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
