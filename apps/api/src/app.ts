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

import { registerAnalysisRoutes } from "./analysis/routes.js";
import type { AnalysisService } from "./analysis/service.js";
import { registerAuthRoutes } from "./auth/routes.js";
import type { AccountAuth } from "./auth/service.js";
import { registerCredentialRoutes } from "./credentials/routes.js";
import type { CredentialService } from "./credentials/service.js";
import { type GameApiOptions, registerGameRoutes } from "./games/routes.js";
import {
  handleRateLimitError,
  registerRequestLimits,
  type RequestLimitOptions,
} from "./limits/http.js";
import { proxyTrust, registerProxyBoundary } from "./limits/proxy.js";
import { registerProfileRoutes } from "./profiles/routes.js";
import type { ProfileService } from "./profiles/service.js";
import type { RoomConnectionLimits } from "./realtime/connections.js";
import type { RoomEvents } from "./realtime/room-events.js";
import { registerRoomRealtime } from "./realtime/routes.js";
import { registerRoomRoutes } from "./rooms/routes.js";
import type { RoomService } from "./rooms/service.js";
import { registerSecurityHeaders } from "./security.js";

export interface ReadinessProbe {
  check(): Promise<void>;
}

export interface BuildAppOptions {
  readonly logger?: FastifyServerOptions["logger"];
  readonly serverFactory?: FastifyServerOptions["serverFactory"];
  readonly readiness: ReadinessProbe;
  readonly webOrigin: string;
  readonly trustedProxyIp?: string;
  readonly requestLimits?: RequestLimitOptions;
  readonly gameApi?: Omit<GameApiOptions, "webOrigin" | "auth">;
  readonly auth?: AccountAuth;
  readonly profiles?: ProfileService;
  readonly credentials?: CredentialService;
  readonly analysis?: AnalysisService;
  readonly rooms?: RoomService;
  readonly roomEvents?: RoomEvents;
  readonly roomRealtimeLimits?: Partial<RoomConnectionLimits>;
}

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1_048_576,
    requestTimeout: 30_000,
    connectionTimeout: 210_000,
    keepAliveTimeout: 5_000,
    trustProxy: proxyTrust(options.trustedProxyIp),
    ...(options.serverFactory ? { serverFactory: options.serverFactory } : {}),
  });
  const routes = app.withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  registerSecurityHeaders(app);
  registerProxyBoundary(app, options.trustedProxyIp);

  await app.register(cookie);

  await app.register(cors, {
    methods: ["GET", "HEAD", "OPTIONS", "POST"],
    credentials: true,
    exposedHeaders: ["Retry-After"],
    origin(origin, callback) {
      callback(null, origin === options.webOrigin);
    },
  });

  registerRequestLimits(app, options.requestLimits);

  if (options.rooms && options.gameApi && options.roomEvents) {
    await app.register(registerRoomRealtime, {
      rooms: options.rooms,
      guests: options.gameApi.guests,
      webOrigin: options.webOrigin,
      events: options.roomEvents,
      ...(options.auth ? { auth: options.auth } : {}),
      ...(options.roomRealtimeLimits ? { limits: options.roomRealtimeLimits } : {}),
    });
  }

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
    if (options.analysis) {
      await app.register(registerAnalysisRoutes, {
        analysis: options.analysis,
        guests: options.gameApi.guests,
        webOrigin: options.webOrigin,
        ...(options.auth ? { auth: options.auth } : {}),
      });
    }
    if (options.rooms) {
      await app.register(registerRoomRoutes, {
        rooms: options.rooms,
        guests: options.gameApi.guests,
        webOrigin: options.webOrigin,
        ...(options.auth ? { auth: options.auth } : {}),
      });
    }
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
    if (handleRateLimitError(error, request, reply)) return;
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
