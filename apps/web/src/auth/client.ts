import {
  authDeleteAccountRequestSchema,
  authEmailRequestSchema,
  authErrorResponseSchema,
  authMethodsResponseSchema,
  type AuthOAuthProvider,
  authOAuthRequestSchema,
  authOAuthStartResponseSchema,
  authResetPasswordRequestSchema,
  authSessionResponseSchema,
  authSignInRequestSchema,
  authSignOutResponseSchema,
  authSignUpRequestSchema,
  authStatusResponseSchema,
  authVerifyEmailRequestSchema,
  profileErrorResponseSchema,
  profileResponseSchema,
  type ProfileUpdateRequest,
  profileUpdateRequestSchema,
} from "@neurochess/contracts";
import { z } from "zod";

const errors = z.union([authErrorResponseSchema, profileErrorResponseSchema]);
export class AccountFailure extends Error {
  constructor(
    readonly code: z.infer<typeof errors>["code"] | "NETWORK",
    readonly retryAfter?: number,
  ) {
    super(code);
  }
}

export function createAccountApi(baseUrl: string, fetcher = globalThis.fetch.bind(globalThis)) {
  const origin = new URL(baseUrl);
  if (
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && origin.hostname === "localhost")) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new AccountFailure("AUTH_INVALID_REQUEST");
  }
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<T> {
    try {
      const response = await fetcher(new URL(path, origin), {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (signal.aborted) throw new AccountFailure("NETWORK");
      const payload: unknown = await response.json();
      if (!response.ok) {
        const parsed = errors.safeParse(payload);
        const retry = Number(response.headers.get("retry-after"));
        throw new AccountFailure(
          parsed.success ? parsed.data.code : "AUTH_UNAVAILABLE",
          Number.isSafeInteger(retry) && retry > 0 ? Math.min(retry, 3600) : undefined,
        );
      }
      const result = schema.safeParse(payload);
      if (!result.success) throw new AccountFailure("AUTH_UNAVAILABLE");
      return result.data;
    } catch (error) {
      if (error instanceof AccountFailure) throw error;
      throw new AccountFailure("NETWORK");
    }
  }
  const post = <T>(path: string, schema: z.ZodType<T>, input: unknown, signal: AbortSignal) =>
    request("/api/auth/" + path, authStatusResponseSchema, signal, schema.parse(input));
  return {
    session: (signal: AbortSignal) =>
      request("/api/auth/get-session", authSessionResponseSchema, signal),
    methods: (signal: AbortSignal) =>
      request("/api/auth/methods", authMethodsResponseSchema, signal),
    signIn: (input: unknown, signal: AbortSignal) =>
      post("sign-in/email", authSignInRequestSchema, input, signal),
    signUp: (input: unknown, signal: AbortSignal) =>
      post("sign-up/email", authSignUpRequestSchema, input, signal),
    resend: (input: unknown, signal: AbortSignal) =>
      post("send-verification-email", authEmailRequestSchema, input, signal),
    forgot: (input: unknown, signal: AbortSignal) =>
      post("request-password-reset", authEmailRequestSchema, input, signal),
    verify: (input: unknown, signal: AbortSignal) =>
      post("verify-email", authVerifyEmailRequestSchema, input, signal),
    reset: (input: unknown, signal: AbortSignal) =>
      post("reset-password", authResetPasswordRequestSchema, input, signal),
    signOut: (signal: AbortSignal) =>
      request("/api/auth/sign-out", authSignOutResponseSchema, signal, {}),
    deleteAccount: (expectedUserId: string, signal: AbortSignal) =>
      post(
        "delete-account",
        authDeleteAccountRequestSchema,
        { confirm: true, expectedUserId },
        signal,
      ),
    async oauth(provider: AuthOAuthProvider, link: boolean, signal: AbortSignal) {
      const result = await request(
        "/api/auth/" + (link ? "link-social" : "sign-in/social"),
        authOAuthStartResponseSchema,
        signal,
        authOAuthRequestSchema.parse({ provider }),
      );
      const url = new URL(result.url);
      const expected =
        provider === "google"
          ? "https://accounts.google.com/o/oauth2/v2/auth"
          : "https://github.com/login/oauth/authorize";
      if (url.origin + url.pathname !== expected || url.username || url.password || url.hash) {
        throw new AccountFailure("AUTH_OAUTH_FAILED");
      }
      return url.href;
    },
    profile: (signal: AbortSignal) => request("/api/profile", profileResponseSchema, signal),
    updateProfile: (input: ProfileUpdateRequest, onboarding: boolean, signal: AbortSignal) =>
      request(
        "/api/profile" + (onboarding ? "/onboarding" : ""),
        profileResponseSchema,
        signal,
        profileUpdateRequestSchema.parse(input),
      ),
  };
}
export type AccountApi = ReturnType<typeof createAccountApi>;
