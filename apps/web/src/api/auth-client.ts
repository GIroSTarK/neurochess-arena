import {
  authAcceptedResponseSchema,
  authDeleteAccountRequestSchema,
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

import { RequestRateLimitFailure } from "./failures";
import { createHttpRequest, validated } from "./http";

export type AccountErrorCode = AuthErrorCode | ProfileErrorCode | "cancelled";

export class AccountFailure extends Error {
  constructor(readonly code: AccountErrorCode) {
    super(code);
    this.name = "AccountFailure";
  }
}

export function accountError(error: unknown): AccountErrorCode {
  if (error instanceof RequestRateLimitFailure) return "AUTH_RATE_LIMITED";
  return error instanceof AccountFailure ? error.code : "AUTH_UNAVAILABLE";
}

export function createAuthApi(apiBaseUrl: string, options: { fetch?: typeof fetch } = {}) {
  const request = createHttpRequest({
    baseUrl: apiBaseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    errors: {
      schema: authErrorResponseSchema.or(profileErrorResponseSchema),
      failure: (kind) =>
        new AccountFailure(kind === "cancelled" ? "cancelled" : "AUTH_UNAVAILABLE"),
      isFailure: (error): error is AccountFailure => error instanceof AccountFailure,
      fromResponse: (error) => new AccountFailure(error.code),
    },
  });
  function input<T>(schema: z.ZodType<T>, value: unknown): T {
    return validated(schema, value, () => new AccountFailure("AUTH_INVALID_REQUEST"));
  }
  return {
    session: (signal: AbortSignal) =>
      request("/api/auth/get-session", authSessionResponseSchema, signal),
    profile: (signal: AbortSignal, expectedAccount?: string) =>
      request("/profile", profileResponseSchema, signal, undefined, { expectedAccount }),
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
        { expectedAccount },
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
    signOut: (signal: AbortSignal, expectedAccount: string) =>
      request("/api/auth/sign-out", authSuccessResponseSchema, signal, {}, { expectedAccount }),
    deleteAccount: (signal: AbortSignal, expectedAccount: string) =>
      request(
        "/api/auth/delete-account",
        authSuccessResponseSchema,
        signal,
        input(authDeleteAccountRequestSchema, { confirm: true }),
        { expectedAccount },
      ),
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
