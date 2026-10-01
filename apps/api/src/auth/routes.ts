import {
  authAcceptedResponseSchema,
  authEmailRequestSchema,
  authEmptyRequestSchema,
  type AuthErrorCode,
  authErrorResponseSchema,
  authRegistrationRequestSchema,
  authResetPasswordRequestSchema,
  authSessionResponseSchema,
  authSignInRequestSchema,
  authSignOutResponseSchema,
  authVerificationQuerySchema,
} from "@neurochess/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { authEmailAcceptedMessage, authErrorMessages } from "../locales/en.js";

import { AUTH_BASE_PATH, AUTH_IP_HEADER } from "./options.js";
import type { AccountAuth } from "./service.js";

const emailRequests = {
  "/sign-up/email": authRegistrationRequestSchema,
  "/sign-in/email": authSignInRequestSchema,
  "/send-verification-email": authEmailRequestSchema,
  "/request-password-reset": authEmailRequestSchema,
  "/reset-password": authResetPasswordRequestSchema,
};
const statusResponseSchema = z.object({ status: z.literal(true) });
const registrationResponseSchema = z.object({ token: z.null(), user: z.object({ id: z.uuid() }) });
const signInResponseSchema = z.object({
  token: z.string().min(1),
  user: z.object({ id: z.uuid() }),
});
const libraryErrorSchema = z.object({ code: z.string() });

function emailRequest(path: string) {
  return Object.hasOwn(emailRequests, path)
    ? emailRequests[path as keyof typeof emailRequests]
    : undefined;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: { auth: AccountAuth; webOrigin: string },
) {
  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const path = request.url.split("?")[0]?.slice(AUTH_BASE_PATH.length) ?? "";
    const allowed =
      (request.method === "GET" && path === "/get-session") ||
      (request.method === "POST" && path === "/sign-out") ||
      (options.auth.emailEnabled &&
        ((request.method === "GET" && path === "/verify-email") ||
          (request.method === "POST" && Boolean(emailRequest(path)))));
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
      const path = request.url.split("?")[0]?.slice(AUTH_BASE_PATH.length) ?? "";
      const querySchema =
        path === "/verify-email" ? authVerificationQuerySchema : authEmptyRequestSchema;
      const bodySchema = emailRequest(path) ?? authEmptyRequestSchema;
      if (
        !querySchema.safeParse(request.query).success ||
        (request.method === "POST" &&
          (!request.headers["content-type"]?.match(/^application\/json(?:\s*;|$)/i) ||
            !bodySchema.safeParse(request.body).success))
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
      // Email flows do not inherit another account's cookie. Only explicit sign-in
      // creates a session; verification and password recovery never auto-sign in.
      if (path !== "/get-session" && path !== "/sign-out") headers.delete("cookie");
      try {
        const body = request.method === "POST" ? bodySchema.parse(request.body) : undefined;
        const response = await options.auth.handle(
          new Request(`${options.auth.baseURL}${request.url}`, {
            method: request.method,
            headers,
            ...(body
              ? { body: JSON.stringify(path === "/sign-up/email" ? { ...body, name: "" } : body) }
              : {}),
          }),
        );
        const cookies = response.headers.getSetCookie();
        if (cookies.length) reply.header("set-cookie", cookies);
        const retryAfter =
          response.headers.get("retry-after") ?? response.headers.get("x-retry-after");
        if (retryAfter && /^\d+$/.test(retryAfter)) reply.header("retry-after", retryAfter);
        if (!response.ok) {
          const error = libraryErrorSchema.safeParse(await response.json().catch(() => null));
          const code = error.success ? safeLibraryError(error.data.code) : undefined;
          return await sendError(request, reply, response.status, code);
        }
        const payload: unknown = await response.json();
        let projected: unknown;
        if (path === "/get-session") projected = authSessionResponseSchema.parse(payload);
        else if (path === "/sign-out") projected = authSignOutResponseSchema.parse(payload);
        else if (path === "/sign-in/email") {
          signInResponseSchema.parse(payload);
          projected = { success: true };
        } else {
          if (path === "/sign-up/email") registrationResponseSchema.parse(payload);
          else statusResponseSchema.parse(payload);
          if (path === "/verify-email") {
            return await reply
              .code(303)
              .header("location", `${options.webOrigin}/?auth=email-verified`)
              .send();
          }
          projected =
            path === "/reset-password"
              ? { success: true }
              : authAcceptedResponseSchema.parse({
                  status: "accepted",
                  message: authEmailAcceptedMessage,
                });
        }
        return await reply.code(response.status).send(projected);
      } catch {
        request.log.error("Authentication request failed");
        return sendError(request, reply, 500);
      }
    },
  });
}

function safeLibraryError(code: string): AuthErrorCode | undefined {
  switch (code) {
    case "AUTH_EMAIL_UNAVAILABLE":
      return "AUTH_EMAIL_UNAVAILABLE";
    case "EMAIL_NOT_VERIFIED":
      return "AUTH_EMAIL_NOT_VERIFIED";
    case "INVALID_EMAIL_OR_PASSWORD":
      return "AUTH_INVALID_CREDENTIALS";
    case "INVALID_TOKEN":
    case "TOKEN_EXPIRED":
      return "AUTH_INVALID_TOKEN";
    default:
      return undefined;
  }
}

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  errorCode?: AuthErrorCode,
) {
  const code: AuthErrorCode =
    errorCode ??
    (status === 401
      ? "AUTH_UNAUTHORIZED"
      : status === 403
        ? "AUTH_FORBIDDEN"
        : status === 404
          ? "AUTH_NOT_FOUND"
          : status === 429
            ? "AUTH_RATE_LIMITED"
            : status >= 500
              ? "AUTH_UNAVAILABLE"
              : "AUTH_INVALID_REQUEST");
  return reply.code(status).send(
    authErrorResponseSchema.parse({
      code,
      message: authErrorMessages[code],
      requestId: request.id,
    }),
  );
}
