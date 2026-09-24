import {
  authEmailRequestSchema,
  type AuthErrorCode,
  authErrorResponseSchema,
  authOAuthCallbackQuerySchema,
  authOAuthRequestSchema,
  authResetPasswordRequestSchema,
  authSessionResponseSchema,
  authSignInRequestSchema,
  authSignOutRequestSchema,
  authSignOutResponseSchema,
  authSignUpRequestSchema,
  authStatusResponseSchema,
  authVerifyEmailRequestSchema,
  emptyQuerySchema,
} from "@neurochess/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { authErrorMessages } from "../locales/en.js";

import {
  authErrorCode,
  authErrorStatus,
  authFailureCode,
  AuthRequestError,
  libraryAuthErrorCode,
} from "./errors.js";
import { OAUTH_COMPLETION_PATH } from "./oauth.js";
import { oauthCallbackLocation, oauthCompletion, oauthStartResponse } from "./oauth-http.js";
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

const postSchemas: Readonly<Record<string, z.ZodType>> = {
  "/sign-out": authSignOutRequestSchema,
  "/sign-up/email": authSignUpRequestSchema,
  "/sign-in/email": authSignInRequestSchema,
  "/send-verification-email": authEmailRequestSchema,
  "/request-password-reset": authEmailRequestSchema,
  "/reset-password": authResetPasswordRequestSchema,
  "/verify-email": authVerifyEmailRequestSchema,
  "/sign-in/social": authOAuthRequestSchema,
  "/link-social": authOAuthRequestSchema,
};

function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: AuthErrorCode = authErrorCode(status),
) {
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
      const path = (request.url.split("?")[0] ?? "").slice(AUTH_BASE_PATH.length);
      const isCallback = request.method === "GET" && /^\/callback\/(google|github)$/.test(path);
      try {
        const isSession = request.method === "GET" && path === "/get-session";
        const isSignOut = request.method === "POST" && path === "/sign-out";
        const isOAuthStart =
          request.method === "POST" && (path === "/sign-in/social" || path === "/link-social");
        const bodySchema = request.method === "POST" ? postSchemas[path] : undefined;
        // New library endpoints must be reviewed before they become public product flows.
        if (!isSession && !bodySchema && !isCallback) throw new AuthRequestError(404);
        if (isOAuthStart && !Object.keys(options.auth.options.socialProviders ?? {}).length) {
          throw new AuthRequestError(404);
        }
        if (
          !isSession &&
          !isSignOut &&
          !isOAuthStart &&
          !isCallback &&
          !options.auth.options.emailAndPassword?.enabled
        ) {
          throw new AuthRequestError(404);
        }
        const origin = request.headers.origin;
        if (
          !isCallback &&
          ((origin !== undefined && origin !== options.webOrigin) || (!isSession && !origin))
        ) {
          throw new AuthRequestError(403);
        }
        const query = (isCallback ? authOAuthCallbackQuerySchema : emptyQuerySchema).safeParse(
          request.query,
        );
        if (!query.success) throw new AuthRequestError(400);
        if (
          bodySchema &&
          request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
            "application/json"
        ) {
          throw new AuthRequestError(400);
        }
        const parsed = bodySchema?.safeParse(request.body);
        if (parsed && !parsed.success) throw new AuthRequestError(400);
        const payload = parsed?.data;
        const oauthProvider = isOAuthStart
          ? authOAuthRequestSchema.parse(payload).provider
          : undefined;
        const configuredProvider =
          oauthProvider ?? (isCallback ? path.slice("/callback/".length) : undefined);
        if (
          configuredProvider &&
          !Object.hasOwn(options.auth.options.socialProviders ?? {}, configuredProvider)
        ) {
          throw new AuthRequestError(404);
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
        // Anonymous sign-in/email operations must not act on an unrelated browser account.
        if (!isSession && !isSignOut && !isCallback && path !== "/link-social") {
          headers.delete("cookie");
        }
        // Fastify does not trust proxies. Never trust client-supplied forwarding/IP headers.
        headers.set(AUTH_IP_HEADER, request.ip);
        const invoke = (libraryPath: string, body?: unknown) =>
          options.auth.handler(
            new Request(`${options.baseURL}${AUTH_BASE_PATH}${libraryPath}`, {
              method: body === undefined ? "GET" : "POST",
              headers,
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
          );
        let libraryPath = path;
        let libraryBody = payload;
        if (isCallback) {
          const callback = authOAuthCallbackQuerySchema.parse(query.data);
          const params = new URLSearchParams();
          for (const key of ["state", "code", "error", "iss"] as const) {
            if (callback[key] !== undefined) params.set(key, callback[key]);
          }
          libraryPath = `${path}?${params.toString()}`;
        } else if (isOAuthStart) {
          libraryBody = {
            provider: oauthProvider,
            disableRedirect: true,
            callbackURL: oauthCompletion(
              options.webOrigin,
              path === "/link-social" ? "linked" : "signed-in",
            ),
            errorCallbackURL: `${options.webOrigin}${OAUTH_COMPLETION_PATH}`,
          };
        } else if (path === "/verify-email") {
          const query = new URLSearchParams(authVerifyEmailRequestSchema.parse(payload));
          libraryPath = `/verify-email?${query.toString()}`;
          libraryBody = undefined;
        } else if (path === "/sign-up/email") {
          // Better Auth requires a name; the user-chosen public profile belongs to onboarding.
          libraryBody = { ...authSignUpRequestSchema.parse(payload), name: "" };
        }
        let response = await invoke(libraryPath, libraryBody);
        if (isCallback) {
          const location = oauthCallbackLocation(response, options.webOrigin);
          forwardAuthHeaders(response, reply);
          return await reply.redirect(location);
        }
        if (response.ok && path === "/sign-up/email") {
          z.object({ token: z.null(), user: z.object({ id: z.string() }) }).parse(
            await response.json(),
          );
          response = await invoke(
            "/send-verification-email",
            authEmailRequestSchema.parse({
              email: authSignUpRequestSchema.parse(payload).email,
            }),
          );
        }
        if (!response.ok) {
          forwardAuthHeaders(response, reply);
          return await sendError(
            request,
            reply,
            response.status,
            libraryAuthErrorCode(response.status, await response.json()),
          );
        }

        const body: unknown = await response.json();
        if (oauthProvider) {
          const result = oauthStartResponse(body, oauthProvider);
          forwardAuthHeaders(response, reply);
          return await reply.code(response.status).send(result);
        }
        if (isSession) {
          const result = librarySessionSchema.parse(body);
          forwardAuthHeaders(response, reply);
          return await reply.code(response.status).send(
            authSessionResponseSchema.parse({
              session: result ? { user: result.user, expiresAt: result.session.expiresAt } : null,
            }),
          );
        }
        if (isSignOut) {
          // Better Auth's sign-out catches storage failures. Do not acknowledge an unrevoked session.
          const remaining = await options.auth.api.getSession({
            headers,
            query: { disableCookieCache: true, disableRefresh: true },
          });
          if (remaining) throw new AuthRequestError(503);
          const result = authSignOutResponseSchema.parse(body);
          forwardAuthHeaders(response, reply);
          return await reply.code(response.status).send(result);
        }
        if (path === "/sign-in/email") {
          z.object({ redirect: z.literal(false), token: z.string().min(1) }).parse(body);
        } else {
          z.object({ status: z.literal(true) }).parse(body);
        }
        forwardAuthHeaders(response, reply);
        return await reply
          .code(response.status)
          .send(authStatusResponseSchema.parse({ status: true }));
      } catch (error: unknown) {
        if (isCallback) {
          return reply.redirect(oauthCompletion(options.webOrigin, "AUTH_OAUTH_FAILED"));
        }
        return sendError(request, reply, authErrorStatus(error), authFailureCode(error));
      }
    },
  });
}
