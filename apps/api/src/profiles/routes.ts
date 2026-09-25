import {
  emptyQuerySchema,
  type ProfileErrorCode,
  profileErrorResponseSchema,
  profileOnboardingRequestSchema,
  profileResponseSchema,
  profileUpdateRequestSchema,
} from "@neurochess/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { AuthRequestError } from "../auth/errors.js";
import type { createAccountIdentityResolver } from "../identity/account.js";
import { profileErrorMessages } from "../locales/en.js";

import { ProfileRequestError, type ProfileService } from "./service.js";

export interface ProfileApiOptions {
  readonly profiles: ProfileService;
  readonly accountIdentity: ReturnType<typeof createAccountIdentityResolver>;
  readonly webOrigin: string;
}
const statuses = {
  PROFILE_UNAUTHORIZED: 401,
  PROFILE_FORBIDDEN: 403,
  PROFILE_INVALID_REQUEST: 400,
  USERNAME_UNAVAILABLE: 409,
  AVATAR_UNAVAILABLE: 409,
  PROFILE_UNAVAILABLE: 500,
} as const satisfies Record<ProfileErrorCode, number>;
const responses = {
  200: profileResponseSchema,
  400: profileErrorResponseSchema,
  401: profileErrorResponseSchema,
  403: profileErrorResponseSchema,
  409: profileErrorResponseSchema,
  500: profileErrorResponseSchema,
};

export async function registerProfileRoutes(app: FastifyInstance, options: ProfileApiOptions) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const principalFor = async (request: FastifyRequest) => {
    const principal = await options.accountIdentity(request);
    if (!principal) throw new ProfileRequestError("PROFILE_UNAUTHORIZED");
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
      throw new ProfileRequestError("PROFILE_FORBIDDEN");
    }
    if (
      request.method === "POST" &&
      request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
    ) {
      throw new ProfileRequestError("PROFILE_INVALID_REQUEST");
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const code: ProfileErrorCode =
      error instanceof ProfileRequestError
        ? error.code
        : error instanceof AuthRequestError && error.statusCode === 401
          ? "PROFILE_UNAUTHORIZED"
          : typeof error === "object" &&
              error !== null &&
              "statusCode" in error &&
              typeof error.statusCode === "number" &&
              error.statusCode >= 400 &&
              error.statusCode < 500
            ? "PROFILE_INVALID_REQUEST"
            : "PROFILE_UNAVAILABLE";
    if (code === "PROFILE_UNAVAILABLE") request.log.error({ code }, "Profile request failed");
    return reply.code(statuses[code]).send(
      profileErrorResponseSchema.parse({
        code,
        message: profileErrorMessages[code],
        requestId: request.id,
      }),
    );
  });
  routes.get(
    "/api/profile",
    { schema: { querystring: emptyQuerySchema, response: responses } },
    async (request) => options.profiles.read(await principalFor(request)),
  );
  for (const [url, body] of [
    ["/api/profile", profileUpdateRequestSchema],
    ["/api/profile/onboarding", profileOnboardingRequestSchema],
  ] as const) {
    routes.post(
      url,
      { bodyLimit: 4096, schema: { body, querystring: emptyQuerySchema, response: responses } },
      async (request) => options.profiles.update(await principalFor(request), request.body),
    );
  }
}
