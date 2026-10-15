import {
  emptyQuerySchema,
  expectedAccountSchema,
  type ProfileErrorCode,
  profileErrorResponseSchema,
  profileOnboardingRequestSchema,
  profileResponseSchema,
  profileUpdateRequestSchema,
} from "@neurochess/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { AccountAuth } from "../auth/service.js";
import { enforcePrincipalLimit, handleRateLimitError } from "../limits/http.js";
import { profileErrorMessages } from "../locales/en.js";

import { ProfileRequestError, type ProfileService } from "./service.js";

const statuses = {
  PROFILE_INVALID_REQUEST: 400,
  PROFILE_UNAUTHORIZED: 401,
  PROFILE_FORBIDDEN: 403,
  PROFILE_USERNAME_TAKEN: 409,
  PROFILE_UNAVAILABLE: 503,
} as const satisfies Record<ProfileErrorCode, number>;

export async function registerProfileRoutes(
  app: FastifyInstance,
  options: {
    auth: AccountAuth;
    profiles: ProfileService;
    webOrigin: string;
  },
) {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
    if (request.method === "POST" && request.headers.origin !== options.webOrigin) {
      throw new ProfileRequestError("PROFILE_FORBIDDEN");
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (handleRateLimitError(error, request, reply)) return;
    const code: ProfileErrorCode =
      error instanceof ProfileRequestError
        ? error.code
        : error &&
            typeof error === "object" &&
            "statusCode" in error &&
            typeof error.statusCode === "number" &&
            error.statusCode >= 400 &&
            error.statusCode < 500
          ? "PROFILE_INVALID_REQUEST"
          : "PROFILE_UNAVAILABLE";
    if (code === "PROFILE_UNAVAILABLE") request.log.error("profile_request_failed");
    return reply.code(statuses[code]).send(
      profileErrorResponseSchema.parse({
        code,
        message: profileErrorMessages[code],
        requestId: request.id,
      }),
    );
  });
  async function principal(request: FastifyRequest) {
    const expected = expectedAccountSchema.safeParse(
      request.headers["x-neurochess-expected-account"],
    );
    if (!expected.success) throw new ProfileRequestError("PROFILE_INVALID_REQUEST");
    const value = await options.auth.resolve(
      new Headers(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
    );
    if (!value || (expected.data !== undefined && expected.data !== value.userId)) {
      throw new ProfileRequestError("PROFILE_UNAUTHORIZED");
    }
    enforcePrincipalLimit(request, value);
    return value;
  }
  const response = {
    200: profileResponseSchema,
    400: profileErrorResponseSchema,
    401: profileErrorResponseSchema,
    403: profileErrorResponseSchema,
    409: profileErrorResponseSchema,
    503: profileErrorResponseSchema,
  };
  routes.get("/profile", { schema: { querystring: emptyQuerySchema, response } }, async (request) =>
    options.profiles.read(await principal(request)),
  );
  for (const [path, body] of [
    ["/profile/onboarding", profileOnboardingRequestSchema],
    ["/profile", profileUpdateRequestSchema],
  ] as const) {
    routes.post(
      path,
      { bodyLimit: 4096, schema: { body, querystring: emptyQuerySchema, response } },
      async (request) => options.profiles.update(await principal(request), request.body),
    );
  }
}
