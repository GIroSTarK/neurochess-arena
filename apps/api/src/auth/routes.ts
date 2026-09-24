import {
  authErrorResponseSchema,
  authSessionResponseSchema,
  authSignOutRequestSchema,
  authSignOutResponseSchema,
  emptyQuerySchema,
} from "@neurochess/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { authErrorMessages } from "../locales/en.js";

import { authErrorCode, authErrorStatus, AuthRequestError } from "./errors.js";
import { AUTH_BASE_PATH, AUTH_IP_HEADER, type AuthService } from "./service.js";

export interface AuthRoutesOptions {
  readonly auth: AuthService;
  readonly baseURL: string;
  readonly webOrigin: string;
}

const librarySessionSchema = z
  .object({
    user: z.object(authSessionResponseSchema.shape.session.unwrap().shape.user.shape),
    session: z.object({ expiresAt: z.iso.datetime() }),
  })
  .nullable();

function sendError(request: FastifyRequest, reply: FastifyReply, status: number) {
  const code = authErrorCode(status);
  if (status >= 500) request.log.error({ code }, "Authentication request failed");
  return reply.code(status).send(
    authErrorResponseSchema.parse({
      code,
      message: authErrorMessages[code],
      requestId: request.id,
    }),
  );
}

function forwardAuthHeaders(response: Response, reply: FastifyReply): void {
  // Headers.forEach folds Set-Cookie; retain each cookie as a separate header.
  const cookies = response.headers.getSetCookie();
  if (cookies.length) reply.header("set-cookie", cookies);
  const retryAfter = response.headers.get("retry-after") ?? response.headers.get("x-retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) reply.header("retry-after", retryAfter);
}

export async function registerAuthRoutes(app: FastifyInstance, options: AuthRoutesOptions) {
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("pragma", "no-cache");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-content-type-options", "nosniff");
  });
  app.setErrorHandler((error, request, reply) => {
    const status =
      error !== null &&
      typeof error === "object" &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
        ? error.statusCode
        : 500;
    return sendError(request, reply, status);
  });

  app.route({
    method: ["GET", "POST"],
    url: `${AUTH_BASE_PATH}/*`,
    bodyLimit: 16_384,
    async handler(request, reply) {
      try {
        const path = request.url.split("?")[0];
        const isSession = request.method === "GET" && path === `${AUTH_BASE_PATH}/get-session`;
        const isSignOut = request.method === "POST" && path === `${AUTH_BASE_PATH}/sign-out`;
        // New library endpoints must be reviewed before they become public product flows.
        if (!isSession && !isSignOut) throw new AuthRequestError(404);
        const origin = request.headers.origin;
        if ((origin !== undefined && origin !== options.webOrigin) || (isSignOut && !origin)) {
          throw new AuthRequestError(403);
        }
        if (!emptyQuerySchema.safeParse(request.query).success) throw new AuthRequestError(400);
        if (
          isSignOut &&
          (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
            "application/json" ||
            !authSignOutRequestSchema.safeParse(request.body).success)
        ) {
          throw new AuthRequestError(400);
        }

        const headers = new Headers();
        for (const name of [
          "cookie",
          "origin",
          "content-type",
          "user-agent",
          "sec-fetch-site",
        ] as const) {
          const value = request.headers[name];
          if (typeof value === "string") headers.set(name, value);
        }
        // Fastify does not trust proxies. Never trust client-supplied forwarding/IP headers.
        headers.set(AUTH_IP_HEADER, request.ip);
        const response = await options.auth.handler(
          new Request(`${options.baseURL}${path}`, {
            method: request.method,
            headers,
            ...(isSignOut ? { body: "{}" } : {}),
          }),
        );
        if (!response.ok) {
          forwardAuthHeaders(response, reply);
          return await sendError(request, reply, response.status);
        }

        const body: unknown = await response.json();
        if (isSession) {
          const result = librarySessionSchema.parse(body);
          forwardAuthHeaders(response, reply);
          return await reply.code(response.status).send(
            authSessionResponseSchema.parse({
              session: result ? { user: result.user, expiresAt: result.session.expiresAt } : null,
            }),
          );
        }
        // Better Auth's sign-out catches storage failures. Do not acknowledge an unrevoked session.
        const remaining = await options.auth.api.getSession({
          headers,
          query: { disableCookieCache: true, disableRefresh: true },
        });
        if (remaining) throw new AuthRequestError(503);
        const result = authSignOutResponseSchema.parse(body);
        forwardAuthHeaders(response, reply);
        return await reply.code(response.status).send(result);
      } catch (error: unknown) {
        return sendError(request, reply, authErrorStatus(error));
      }
    },
  });
}
