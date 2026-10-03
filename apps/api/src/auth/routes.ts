import {
  authAcceptedResponseSchema,
  authDeleteAccountRequestSchema,
  authEmailRequestSchema,
  authEmptyRequestSchema,
  type AuthErrorCode,
  authErrorResponseSchema,
  authOAuthCallbackQuerySchema,
  authOAuthProviderSchema,
  authOAuthSignInRequestSchema,
  authOAuthSignInResponseSchema,
  authRegistrationRequestSchema,
  authResetPasswordRequestSchema,
  authSessionResponseSchema,
  authSignInRequestSchema,
  authSignOutResponseSchema,
  authVerificationQuerySchema,
  expectedAccountSchema,
} from "@neurochess/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { authEmailAcceptedMessage, authErrorMessages } from "../locales/en.js";

import { oauthAuthorizationEndpoints } from "./oauth.js";
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
  const fail = (
    request: FastifyRequest,
    reply: FastifyReply,
    status: number,
    code?: AuthErrorCode,
  ) => {
    if (
      options.auth.emailEnabled &&
      request.method === "GET" &&
      request.url.split("?")[0] === `${AUTH_BASE_PATH}/verify-email` &&
      request.headers.accept?.includes("text/html")
    ) {
      const safeCode =
        code ??
        (status >= 500
          ? "AUTH_UNAVAILABLE"
          : status === 429
            ? "AUTH_RATE_LIMITED"
            : "AUTH_INVALID_TOKEN");
      return reply
        .code(303)
        .header("location", `${options.webOrigin}/?auth=verification-error&code=${safeCode}`)
        .send();
    }
    return sendError(request, reply, status, code);
  };
  const callbackProvider = (path: string) => {
    if (!path.startsWith("/callback/")) return undefined;
    const parsed = authOAuthProviderSchema.safeParse(path.slice("/callback/".length));
    return parsed.success && options.auth.oauthProviders?.includes(parsed.data)
      ? parsed.data
      : undefined;
  };
  const oauthFailure = (reply: FastifyReply, code: AuthErrorCode = "AUTH_OAUTH_FAILED") =>
    reply
      .code(303)
      .header("location", `${options.webOrigin}/?auth=oauth-error&code=${code}`)
      .send();
  app.addHook("onClose", async () => options.auth.close?.());
  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const path = request.url.split("?")[0]?.slice(AUTH_BASE_PATH.length) ?? "";
    const allowed =
      (request.method === "GET" && path === "/get-session") ||
      (request.method === "POST" && path === "/sign-out") ||
      (request.method === "POST" && path === "/delete-account") ||
      (request.method === "POST" &&
        path === "/sign-in/social" &&
        Boolean(options.auth.oauthProviders?.length)) ||
      (request.method === "GET" && Boolean(callbackProvider(path))) ||
      (options.auth.emailEnabled &&
        ((request.method === "GET" && path === "/verify-email") ||
          (request.method === "POST" && Boolean(emailRequest(path)))));
    if (!allowed) return fail(request, reply, 404);
    if (
      (request.headers.origin !== undefined && request.headers.origin !== options.webOrigin) ||
      (request.method === "POST" && request.headers.origin !== options.webOrigin)
    ) {
      return fail(request, reply, 403);
    }
  });

  app.setErrorHandler((_error, request, reply) => fail(request, reply, 400));
  app.route({
    method: ["GET", "POST"],
    url: `${AUTH_BASE_PATH}/*`,
    bodyLimit: 16_384,
    async handler(request, reply) {
      const path = request.url.split("?")[0]?.slice(AUTH_BASE_PATH.length) ?? "";
      const isCallback = Boolean(callbackProvider(path));
      const querySchema = isCallback
        ? authOAuthCallbackQuerySchema
        : path === "/verify-email"
          ? authVerificationQuerySchema
          : authEmptyRequestSchema;
      const bodySchema =
        path === "/sign-in/social"
          ? authOAuthSignInRequestSchema
          : path === "/delete-account"
            ? authDeleteAccountRequestSchema
            : (emailRequest(path) ?? authEmptyRequestSchema);
      if (
        !querySchema.safeParse(request.query).success ||
        (request.method === "POST" &&
          (!request.headers["content-type"]?.match(/^application\/json(?:\s*;|$)/i) ||
            !bodySchema.safeParse(request.body).success))
      ) {
        if (isCallback) return oauthFailure(reply);
        return fail(request, reply, 400);
      }
      if (
        path === "/sign-in/social" &&
        !options.auth.oauthProviders?.includes(
          authOAuthSignInRequestSchema.parse(request.body).provider,
        )
      ) {
        return fail(request, reply, 404);
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
      if (
        path !== "/get-session" &&
        path !== "/sign-out" &&
        path !== "/delete-account" &&
        !isCallback
      ) {
        headers.delete("cookie");
      }
      try {
        if (path === "/sign-out" || path === "/delete-account") {
          const expected = expectedAccountSchema.safeParse(
            request.headers["x-neurochess-expected-account"],
          );
          if (!expected.success) return await fail(request, reply, 400);
          if (expected.data !== undefined) {
            const account = await options.auth.resolve(headers);
            if (expected.data !== account?.userId) return await fail(request, reply, 401);
          }
        }
        const body = request.method === "POST" ? bodySchema.parse(request.body) : undefined;
        const libraryBody =
          path === "/sign-in/social"
            ? {
                ...body,
                disableRedirect: true,
                callbackURL: `${options.webOrigin}/?auth=signed-in`,
                newUserCallbackURL: `${options.webOrigin}/?auth=signed-in`,
                errorCallbackURL: `${options.webOrigin}/?auth=oauth-error`,
              }
            : path === "/sign-up/email"
              ? { ...body, name: "" }
              : body;
        const logger = request.log;
        const response = await options.auth.handle(
          new Request(`${options.auth.baseURL}${request.url}`, {
            method: request.method,
            headers,
            ...(body ? { body: JSON.stringify(libraryBody) } : {}),
          }),
          () =>
            logger.warn(
              { event: "auth_email_delivery_failed" },
              "Authentication email delivery failed",
            ),
        );
        const cookies = response.headers.getSetCookie();
        if (cookies.length) reply.header("set-cookie", cookies);
        const retryAfter =
          response.headers.get("retry-after") ?? response.headers.get("x-retry-after");
        if (retryAfter && /^\d+$/.test(retryAfter)) reply.header("retry-after", retryAfter);
        if (isCallback) {
          const location = response.headers.get("location");
          if (response.status >= 300 && response.status < 400 && location) {
            if (location === `${options.webOrigin}/?auth=signed-in`) {
              return await reply.code(303).header("location", location).send();
            }
            const errorUrl = new URL(location);
            const code =
              errorUrl.origin === options.webOrigin && errorUrl.pathname === "/"
                ? safeOAuthError(errorUrl.searchParams.get("error"))
                : "AUTH_OAUTH_FAILED";
            return await oauthFailure(reply, code);
          }
          const error = libraryErrorSchema.safeParse(await response.json().catch(() => null));
          return await oauthFailure(reply, safeOAuthError(error.success ? error.data.code : null));
        }
        if (!response.ok) {
          const error = libraryErrorSchema.safeParse(await response.json().catch(() => null));
          const code = error.success ? safeLibraryError(error.data.code) : undefined;
          return await fail(request, reply, response.status, code);
        }
        const payload: unknown = await response.json();
        let projected: unknown;
        if (path === "/sign-in/social") {
          const result = authOAuthSignInResponseSchema.strip().parse(payload);
          const provider = authOAuthSignInRequestSchema.parse(request.body).provider;
          const url = new URL(result.url);
          if (
            `${url.origin}${url.pathname}` !== oauthAuthorizationEndpoints[provider] ||
            url.username ||
            url.password ||
            url.hash
          ) {
            throw new Error("Invalid OAuth authorization destination");
          }
          projected = result;
        } else if (path === "/get-session") projected = authSessionResponseSchema.parse(payload);
        else if (path === "/sign-out" || path === "/delete-account") {
          projected = authSignOutResponseSchema.parse(payload);
        } else if (path === "/sign-in/email") {
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
        if (isCallback) return oauthFailure(reply);
        return fail(request, reply, 500);
      }
    },
  });
}

function safeOAuthError(code: string | null): AuthErrorCode {
  switch (code) {
    case "access_denied":
      return "AUTH_OAUTH_CANCELLED";
    case "account_not_linked":
      return "AUTH_OAUTH_ACCOUNT_CONFLICT";
    case "email_not_found":
    case "email_not_verified":
    case "AUTH_OAUTH_EMAIL_UNAVAILABLE":
      return "AUTH_OAUTH_EMAIL_UNAVAILABLE";
    default:
      return "AUTH_OAUTH_FAILED";
  }
}

function safeLibraryError(code: string): AuthErrorCode | undefined {
  switch (code) {
    case "AUTH_REAUTH_REQUIRED":
      return "AUTH_REAUTH_REQUIRED";
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
