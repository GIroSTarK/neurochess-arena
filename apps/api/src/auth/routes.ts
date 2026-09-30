import {
  authEmptyRequestSchema,
  type AuthErrorCode,
  authErrorResponseSchema,
  authSessionResponseSchema,
  authSignOutResponseSchema,
} from "@neurochess/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { authErrorMessages } from "../locales/en.js";

import { AUTH_BASE_PATH, AUTH_IP_HEADER } from "./options.js";
import type { AccountAuth } from "./service.js";

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: { auth: AccountAuth; webOrigin: string },
) {
  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const path = request.url.split("?")[0];
    const allowed =
      (request.method === "GET" && path === `${AUTH_BASE_PATH}/get-session`) ||
      (request.method === "POST" && path === `${AUTH_BASE_PATH}/sign-out`);
    if (!allowed) return sendError(request, reply, 404);
    if (
      (request.headers.origin !== undefined && request.headers.origin !== options.webOrigin) ||
      (request.method === "POST" && request.headers.origin !== options.webOrigin)
    ) {
      return sendError(request, reply, 403);
    }
  });

  app.setErrorHandler((_error, request, reply) => sendError(request, reply, 400));
  app.route({
    method: ["GET", "POST"],
    url: `${AUTH_BASE_PATH}/*`,
    bodyLimit: 16_384,
    async handler(request, reply) {
      if (
        !authEmptyRequestSchema.safeParse(request.query).success ||
        (request.method === "POST" &&
          (!request.headers["content-type"]?.match(/^application\/json(?:\s*;|$)/i) ||
            !authEmptyRequestSchema.safeParse(request.body).success))
      ) {
        return sendError(request, reply, 400);
      }
      const headers = new Headers();
      for (const name of [
        "cookie",
        "origin",
        "content-type",
        "user-agent",
        "sec-fetch-site",
        "sec-fetch-mode",
        "sec-fetch-dest",
      ]) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      // Fastify does not trust proxies. Client-provided forwarding headers cannot
      // select the auth origin or escape the library's IP-based rate limits.
      headers.set(AUTH_IP_HEADER, request.ip);
      try {
        const response = await options.auth.handle(
          new Request(`${options.auth.baseURL}${request.url}`, {
            method: request.method,
            headers,
            ...(request.method === "POST" ? { body: JSON.stringify(request.body) } : {}),
          }),
        );
        const cookies = response.headers.getSetCookie();
        if (cookies.length) reply.header("set-cookie", cookies);
        const retryAfter =
          response.headers.get("retry-after") ?? response.headers.get("x-retry-after");
        if (retryAfter && /^\d+$/.test(retryAfter)) reply.header("retry-after", retryAfter);
        if (!response.ok) return await sendError(request, reply, response.status);
        const payload: unknown = await response.json();
        const projected =
          request.method === "GET"
            ? authSessionResponseSchema.parse(payload)
            : authSignOutResponseSchema.parse(payload);
        return await reply.code(response.status).send(projected);
      } catch {
        request.log.error("Authentication request failed");
        return sendError(request, reply, 500);
      }
    },
  });
}

function sendError(request: FastifyRequest, reply: FastifyReply, status: number) {
  const code: AuthErrorCode =
    status === 401
      ? "AUTH_UNAUTHORIZED"
      : status === 403
        ? "AUTH_FORBIDDEN"
        : status === 404
          ? "AUTH_NOT_FOUND"
          : status === 429
            ? "AUTH_RATE_LIMITED"
            : status >= 500
              ? "AUTH_UNAVAILABLE"
              : "AUTH_INVALID_REQUEST";
  return reply.code(status).send(
    authErrorResponseSchema.parse({
      code,
      message: authErrorMessages[code],
      requestId: request.id,
    }),
  );
}
