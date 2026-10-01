import {
  authAcceptedResponseSchema,
  authEmailRequestSchema,
  type AuthErrorCode,
  authErrorResponseSchema,
  type AuthOAuthProvider,
  authOAuthSignInRequestSchema,
  authOAuthSignInResponseSchema,
  authRegistrationRequestSchema,
  authResetPasswordRequestSchema,
  authSessionResponseSchema,
  authSignInRequestSchema,
  authSuccessResponseSchema,
  type ProfileErrorCode,
  profileErrorResponseSchema,
  profileOnboardingRequestSchema,
  profileResponseSchema,
  type ProfileUpdateRequest,
  profileUpdateRequestSchema,
} from "@neurochess/contracts";
import type { z } from "zod";

export type AccountErrorCode = AuthErrorCode | ProfileErrorCode | "cancelled";

export class AccountFailure extends Error {
  constructor(readonly code: AccountErrorCode) {
    super(code);
    this.name = "AccountFailure";
  }
}

export function accountError(error: unknown): AccountErrorCode {
  return error instanceof AccountFailure ? error.code : "AUTH_UNAVAILABLE";
}

export function createAuthApi(apiBaseUrl: string, options: { fetch?: typeof fetch } = {}) {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    body?: unknown,
    expectedAccount?: string,
  ): Promise<T> {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(cancel, 10_000);
    try {
      if (signal.aborted) throw new AccountFailure("cancelled");
      const response = await fetcher(new URL(path, apiBaseUrl), {
        method: body === undefined ? "GET" : "POST",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {
          accept: "application/json",
          ...(expectedAccount ? { "x-neurochess-expected-account": expectedAccount } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: abort.signal,
      });
      const payload: unknown = await response.json();
      if (abort.signal.aborted) throw new AccountFailure("AUTH_UNAVAILABLE");
      if (!response.ok) {
        const error = authErrorResponseSchema.or(profileErrorResponseSchema).safeParse(payload);
        throw new AccountFailure(error.success ? error.data.code : "AUTH_UNAVAILABLE");
      }
      const result = schema.safeParse(payload);
      if (!result.success) throw new AccountFailure("AUTH_UNAVAILABLE");
      return result.data;
    } catch (error) {
      if (signal.aborted) throw new AccountFailure("cancelled");
      if (error instanceof AccountFailure) throw error;
      throw new AccountFailure("AUTH_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
    }
  }
  function input<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new AccountFailure("AUTH_INVALID_REQUEST");
    return parsed.data;
  }
  return {
    session: (signal: AbortSignal) =>
      request("/api/auth/get-session", authSessionResponseSchema, signal),
    profile: (signal: AbortSignal, expectedAccount?: string) =>
      request("/profile", profileResponseSchema, signal, undefined, expectedAccount),
    saveProfile: (
      value: ProfileUpdateRequest,
      onboarding: boolean,
      signal: AbortSignal,
      expectedAccount?: string,
    ) =>
      request(
        onboarding ? "/profile/onboarding" : "/profile",
        profileResponseSchema,
        signal,
        input(onboarding ? profileOnboardingRequestSchema : profileUpdateRequestSchema, value),
        expectedAccount,
      ),
    signIn: (value: { email: string; password: string }, signal: AbortSignal) =>
      request(
        "/api/auth/sign-in/email",
        authSuccessResponseSchema,
        signal,
        input(authSignInRequestSchema, value),
      ),
    register: (value: { email: string; password: string }, signal: AbortSignal) =>
      request(
        "/api/auth/sign-up/email",
        authAcceptedResponseSchema,
        signal,
        input(authRegistrationRequestSchema, value),
      ),
    resend: (email: string, signal: AbortSignal) =>
      request(
        "/api/auth/send-verification-email",
        authAcceptedResponseSchema,
        signal,
        input(authEmailRequestSchema, { email }),
      ),
    forgot: (email: string, signal: AbortSignal) =>
      request(
        "/api/auth/request-password-reset",
        authAcceptedResponseSchema,
        signal,
        input(authEmailRequestSchema, { email }),
      ),
    reset: (token: string, newPassword: string, signal: AbortSignal) =>
      request(
        "/api/auth/reset-password",
        authSuccessResponseSchema,
        signal,
        input(authResetPasswordRequestSchema, { token, newPassword }),
      ),
    signOut: (signal: AbortSignal) =>
      request("/api/auth/sign-out", authSuccessResponseSchema, signal, {}),
    async social(provider: AuthOAuthProvider, signal: AbortSignal) {
      const result = await request(
        "/api/auth/sign-in/social",
        authOAuthSignInResponseSchema,
        signal,
        input(authOAuthSignInRequestSchema, { provider }),
      );
      const url = new URL(result.url);
      const endpoint =
        provider === "google"
          ? "https://accounts.google.com/o/oauth2/v2/auth"
          : "https://github.com/login/oauth/authorize";
      if (url.origin + url.pathname !== endpoint || url.username || url.password || url.hash) {
        throw new AccountFailure("AUTH_UNAVAILABLE");
      }
      return result.url;
    },
  };
}

export type AuthApi = ReturnType<typeof createAuthApi>;
